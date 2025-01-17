import fs, { WriteStream } from 'fs';
import YAML from 'yaml';
import { diff } from 'semver';
import { Editor } from './editor';
import { readFile } from './fs';
import {
  debug,
  hasProperty,
  wrapError,
  isObject,
  runCommand,
} from './misc-utils';
import { Project } from './project';
import { isValidSemver, semver, SemVer } from './semver';

/**
 * The SemVer-compatible parts of a version string that can be bumped by this
 * tool.
 */
export enum IncrementableVersionParts {
  major = 'major',
  minor = 'minor',
  patch = 'patch',
}

/**
 * Describes how to update the version for a package, either by bumping a part
 * of the version or by setting that version exactly.
 */
type VersionSpecifier = IncrementableVersionParts | SemVer;

/**
 * User-provided instructions for how to update this project in order to prepare
 * it for a new release.
 *
 * @property packages - A mapping of package names to version specifiers.
 * @property path - The path to the original release specification file.
 */
export type ReleaseSpecification = {
  packages: Record<string, VersionSpecifier>;
  path: string;
};

const SKIP_PACKAGE_DIRECTIVE = null;
const INTENTIONALLY_SKIP_PACKAGE_DIRECTIVE = 'intentionally-skip';

/**
 * Generates a skeleton for a release specification, which describes how a
 * project should be updated.
 *
 * @param args - The set of arguments to this function.
 * @param args.project - Information about the project.
 * @param args.isEditorAvailable - Whether or not an executable can be found on
 * the user's computer to edit the release spec once it is generated.
 * @returns The release specification template.
 */
export async function generateReleaseSpecificationTemplateForMonorepo({
  project: { rootPackage, workspacePackages },
  isEditorAvailable,
}: {
  project: Project;
  isEditorAvailable: boolean;
}) {
  const afterEditingInstructions = isEditorAvailable
    ? `
# When you're finished making your selections, save this file and
# create-release-branch will continue automatically.`.trim()
    : `
# When you're finished making your selections, save this file and then re-run
# create-release-branch.`.trim();

  const instructions = `
# The following is a list of packages in ${rootPackage.validatedManifest.name}.
# Please indicate the packages for which you want to create a new release
# by updating "null" to one of the following:
#
# - "major" (if you want to bump the major part of the package's version)
# - "minor" (if you want to bump the minor part of the package's version)
# - "patch" (if you want to bump the patch part of the package's version)
# - an exact version with major, minor, and patch parts (e.g. "1.2.3")
# - intentionally-skip (to skip the package entirely)
#
${afterEditingInstructions}
  `.trim();

  const changedWorkspacePackages = Object.values(workspacePackages).filter(
    (pkg) => pkg.hasChangesSinceLatestRelease,
  );

  if (changedWorkspacePackages.length === 0) {
    throw new Error(
      'Could not generate release specification: There are no packages that have changed since their latest release.',
    );
  }

  const packages = changedWorkspacePackages.reduce((obj, pkg) => {
    return { ...obj, [pkg.validatedManifest.name]: SKIP_PACKAGE_DIRECTIVE };
  }, {});

  return [instructions, YAML.stringify({ packages })].join('\n\n');
}

/**
 * Launches the given editor to allow the user to update the release spec
 * file.
 *
 * @param releaseSpecificationPath - The path to the release spec file.
 * @param editor - Information about the editor.
 * @param stdout - A stream that can be used to write to standard out. Defaults
 * to /dev/null.
 * @returns A promise that resolves when the user has completed editing the
 * file, i.e. when the editor process completes.
 */
export async function waitForUserToEditReleaseSpecification(
  releaseSpecificationPath: string,
  editor: Editor,
  stdout: Pick<WriteStream, 'write'> = fs.createWriteStream('/dev/null'),
) {
  let caughtError: unknown;

  debug(
    `Opening release spec file ${releaseSpecificationPath} with editor located at ${editor.path}...`,
  );

  const promiseForEditorCommand = runCommand(
    editor.path,
    [...editor.args, releaseSpecificationPath],
    {
      stdio: 'inherit',
      shell: true,
    },
  );

  stdout.write('Waiting for the release spec to be edited...');

  try {
    await promiseForEditorCommand;
  } catch (error) {
    caughtError = error;
  }

  // Clear the previous line
  stdout.write('\r\u001B[K');

  if (caughtError) {
    throw wrapError(
      'Encountered an error while waiting for the release spec to be edited.',
      caughtError,
    );
  }
}

/**
 * Looks over the release spec that the user has edited to ensure that:
 *
 * 1. the names of all packages match those within the project; and
 * 2. the version specifiers for each package are valid.
 *
 * @param project - Information about the whole project (e.g., names of packages
 * and where they can found).
 * @param releaseSpecificationPath - The path to the release spec file.
 * @returns The validated release spec.
 * @throws If there are any issues with the file.
 */
export async function validateReleaseSpecification(
  project: Project,
  releaseSpecificationPath: string,
): Promise<ReleaseSpecification> {
  const releaseSpecificationContents = await readFile(releaseSpecificationPath);
  const indexOfFirstUsableLine = releaseSpecificationContents
    .split('\n')
    .findIndex((line) => !/^#|[ ]+/u.test(line));

  let unvalidatedReleaseSpecification: {
    packages: Record<string, string | null>;
  };

  const afterwordForAllErrorMessages = [
    "The release spec file has been retained for you to edit again and make the necessary fixes. Once you've done this, re-run this tool.",
    releaseSpecificationPath,
  ].join('\n\n');

  try {
    unvalidatedReleaseSpecification = YAML.parse(releaseSpecificationContents);
  } catch (error) {
    throw wrapError(
      [
        'Your release spec does not appear to be valid YAML.',
        afterwordForAllErrorMessages,
      ].join('\n\n'),
      error,
    );
  }

  if (
    !isObject(unvalidatedReleaseSpecification) ||
    unvalidatedReleaseSpecification.packages === undefined
  ) {
    const message = [
      `Your release spec could not be processed because it needs to be an object with a \`packages\` property. The value of \`packages\` must itself be an object, where each key is a workspace package in the project and each value is a version specifier ("major", "minor", or "patch"; or a version string with major, minor, and patch parts, such as "1.2.3").`,
      `Here is the parsed version of the file you provided:`,
      JSON.stringify(unvalidatedReleaseSpecification, null, 2),
      afterwordForAllErrorMessages,
    ].join('\n\n');
    throw new Error(message);
  }

  const errors: { message: string | string[]; lineNumber?: number }[] = [];

  Object.entries(unvalidatedReleaseSpecification.packages).forEach(
    ([changedPackageName, versionSpecifierOrDirective], index) => {
      const lineNumber = indexOfFirstUsableLine + index + 2;
      const changedPackage = project.workspacePackages[changedPackageName];

      if (changedPackage === undefined) {
        errors.push({
          message: `${JSON.stringify(
            changedPackageName,
          )} is not a package in the project`,
          lineNumber,
        });
      }

      if (
        versionSpecifierOrDirective !== SKIP_PACKAGE_DIRECTIVE &&
        versionSpecifierOrDirective !== INTENTIONALLY_SKIP_PACKAGE_DIRECTIVE &&
        !hasProperty(IncrementableVersionParts, versionSpecifierOrDirective) &&
        !isValidSemver(versionSpecifierOrDirective)
      ) {
        errors.push({
          message: [
            `${JSON.stringify(
              versionSpecifierOrDirective,
            )} is not a valid version specifier for package "${changedPackageName}"`,
            `(must be "major", "minor", or "patch"; or a version string with major, minor, and patch parts, such as "1.2.3")`,
          ],
          lineNumber,
        });
      }

      if (isValidSemver(versionSpecifierOrDirective)) {
        const comparison = new SemVer(versionSpecifierOrDirective).compare(
          changedPackage.validatedManifest.version,
        );

        if (comparison === 0) {
          errors.push({
            message: [
              `${JSON.stringify(
                versionSpecifierOrDirective,
              )} is not a valid version specifier for package "${changedPackageName}"`,
              `("${changedPackageName}" is already at version "${versionSpecifierOrDirective}")`,
            ],
            lineNumber,
          });
        } else if (comparison < 0) {
          errors.push({
            message: [
              `${JSON.stringify(
                versionSpecifierOrDirective,
              )} is not a valid version specifier for package "${changedPackageName}"`,
              `("${changedPackageName}" is at a greater version "${project.workspacePackages[changedPackageName].validatedManifest.version}")`,
            ],
            lineNumber,
          });
        }
      }

      // Check to compel users to release packages with breaking changes alongside their dependents
      if (
        versionSpecifierOrDirective === 'major' ||
        (isValidSemver(versionSpecifierOrDirective) &&
          diff(
            changedPackage.validatedManifest.version,
            versionSpecifierOrDirective,
          ) === 'major')
      ) {
        const dependentNames = Object.keys(project.workspacePackages).filter(
          (possibleDependentName) => {
            const possibleDependent =
              project.workspacePackages[possibleDependentName];
            const { dependencies, peerDependencies } =
              possibleDependent.validatedManifest;
            return (
              hasProperty(dependencies, changedPackageName) ||
              hasProperty(peerDependencies, changedPackageName)
            );
          },
        );
        const changedDependentNames = dependentNames.filter(
          (possibleDependentName) => {
            return project.workspacePackages[possibleDependentName]
              .hasChangesSinceLatestRelease;
          },
        );
        const missingDependentNames = changedDependentNames.filter(
          (dependentName) => {
            return !unvalidatedReleaseSpecification.packages[dependentName];
          },
        );

        if (missingDependentNames.length > 0) {
          errors.push({
            message: [
              `The following dependents of package '${changedPackageName}', which is being released with a major version bump, are missing from the release spec.`,
              missingDependentNames
                .map((dependent) => `  - ${dependent}`)
                .join('\n'),
              ` Consider including them in the release spec so that they are compatible with the new '${changedPackageName}' version.`,
              `  If you are ABSOLUTELY SURE these packages are safe to omit, however, and want to postpone the release of a package, then list it with a directive of "intentionally-skip". For example:`,
              YAML.stringify({
                packages: missingDependentNames.reduce((object, dependent) => {
                  return {
                    ...object,
                    [dependent]: INTENTIONALLY_SKIP_PACKAGE_DIRECTIVE,
                  };
                }, {}),
              })
                .trim()
                .split('\n')
                .map((line) => `    ${line}`)
                .join('\n'),
            ].join('\n\n'),
          });
        }
      }

      // Check to compel users to release new versions of dependencies alongside their dependents
      if (
        changedPackage &&
        versionSpecifierOrDirective &&
        (hasProperty(IncrementableVersionParts, versionSpecifierOrDirective) ||
          isValidSemver(versionSpecifierOrDirective))
      ) {
        const missingDependencies = Object.keys({
          ...changedPackage.validatedManifest.dependencies,
          ...changedPackage.validatedManifest.peerDependencies,
        }).filter((dependency) => {
          return (
            project.workspacePackages[dependency]
              ?.hasChangesSinceLatestRelease &&
            !unvalidatedReleaseSpecification.packages[dependency]
          );
        });

        if (missingDependencies.length > 0) {
          errors.push({
            message: [
              `The following packages, which are dependencies or peer dependencies of the package '${changedPackageName}' being released, are missing from the release spec.`,
              missingDependencies
                .map((dependency) => `  - ${dependency}`)
                .join('\n'),
              `  These packages may have changes that '${changedPackageName}' relies upon. Consider including them in the release spec.`,
              `  If you are ABSOLUTELY SURE these packages are safe to omit, however, and want to postpone the release of a package, then list it with a directive of "intentionally-skip". For example:`,
              YAML.stringify({
                packages: missingDependencies.reduce((object, dependency) => {
                  return {
                    ...object,
                    [dependency]: INTENTIONALLY_SKIP_PACKAGE_DIRECTIVE,
                  };
                }, {}),
              })
                .trim()
                .split('\n')
                .map((line) => `    ${line}`)
                .join('\n'),
            ].join('\n\n'),
          });
        }
      }
    },
  );

  if (errors.length > 0) {
    const message = [
      'Your release spec could not be processed due to the following issues:',
      errors
        .flatMap((error) => {
          const itemPrefix = '* ';

          if (error.lineNumber === undefined) {
            return `${itemPrefix}${error.message}`;
          }

          const lineNumberPrefix = `Line ${error.lineNumber}: `;

          if (Array.isArray(error.message)) {
            return [
              `${itemPrefix}${lineNumberPrefix}${error.message[0]}`,
              ...error.message.slice(1).map((line) => {
                const indentedLineLength =
                  itemPrefix.length + lineNumberPrefix.length + line.length;
                return line.padStart(indentedLineLength, ' ');
              }),
            ];
          }

          return `${itemPrefix}${lineNumberPrefix}${error.message}`;
        })
        .join('\n'),
      afterwordForAllErrorMessages,
    ].join('\n\n');
    throw new Error(message);
  }

  const packages = Object.keys(unvalidatedReleaseSpecification.packages).reduce(
    (obj, packageName) => {
      const versionSpecifierOrDirective =
        unvalidatedReleaseSpecification.packages[packageName];

      if (
        versionSpecifierOrDirective !== SKIP_PACKAGE_DIRECTIVE &&
        versionSpecifierOrDirective !== INTENTIONALLY_SKIP_PACKAGE_DIRECTIVE
      ) {
        if (
          Object.values(IncrementableVersionParts).includes(
            // Typecast: It doesn't matter what type versionSpecifierOrDirective
            // is as we are checking for inclusion.
            versionSpecifierOrDirective as any,
          )
        ) {
          return {
            ...obj,
            // Typecast: We know what this is as we've checked it above.
            [packageName]:
              versionSpecifierOrDirective as IncrementableVersionParts,
          };
        }

        return {
          ...obj,
          // Typecast: We know that this will safely parse.
          [packageName]: semver.parse(versionSpecifierOrDirective) as SemVer,
        };
      }

      return obj;
    },
    {} as ReleaseSpecification['packages'],
  );

  return { packages, path: releaseSpecificationPath };
}
