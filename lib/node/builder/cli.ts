import { Command } from 'commander';
import { getDependencyErrors, getComponentsMap, orderBuildsInGroups, calculateComponentHashes, findBuilderConfig, buildAllGroups, getActiveBuilderConfig, resolveBuildEnvironment, BuilderCustomOptions } from './builder';
import { globalRoot } from 'ts-basis';
import * as crypto from 'crypto';
import * as pathlib from 'path'
import packageJSON from '../package.json'
const colors = require('colors/safe')

const cli = new Command()
const version = packageJSON.version
const binName = Object.keys(packageJSON.bin)[0]

cli.name(binName)
    .description(`advanced project components building framework`)
    .version(version);

const v1 = cli.command('v1');

v1.command('build')
.option('--tag <tag>', 'image tag for the build set (branch name or run number). If not given, the tag is auto-generated')
.option('--working-directory <workingDirectory>', 'change directory to specified dir before running the build')
.option('--head-branch <headBranch>', 'working branch name for precommit')
.option('--base-branch <baseBranch>', 'base branch for the working branch')
.option('--no-prebuilt', 'disables build skipping when prebuilt images with the same shasum is detected')
.option('--no-cache', 'disables docker cache and build all layers')
.option('--precommit-context <precommitContext>', 'context metadata for precommit (PR) flow')
.option('--ci', 'whether the current build is during CI flow')
.description(`build components with parameters, v1`)
.action(async (options: BuilderCustomOptions) => {
    const exit = (code = 0) => setTimeout(() => process.exit(code), 500) as any
    console.log('')
    console.log(colors.gray(`build invoked with following options: {`))
    for (const optionName of Object.keys(options)) {
        console.log(colors.gray(`   ${optionName}: ${colors.cyan(options[optionName])}`))    
    }
    console.log(colors.gray('}'))
    if (options.workingDirectory) {
        const newDir = pathlib.join(process.cwd(), options.workingDirectory)
        try {
            process.chdir(newDir)
        } catch (e) {
            console.error(`ERROR; unable to change directory to '${options.workingDirectory}' (${newDir})`)
            return exit(1)
        }
    }
    const configChain = await findBuilderConfig()
    const activeConfig = getActiveBuilderConfig(configChain)
    await resolveBuildEnvironment(activeConfig, options)
    activeConfig.start_time = Date.now()
    const [ compoMap, fileErrors ] = await getComponentsMap();
    if (fileErrors) {
        for (const err of fileErrors) { console.error(colors.red(err.e)); } return exit(1)
    }
    const depErrors  = getDependencyErrors(compoMap);
    if (depErrors) {
        for (const err of depErrors) { console.error(colors.red(err.e)); } return exit(1)
    }
    const buildGroups = orderBuildsInGroups(compoMap);
    const hashCalculationErrors = await calculateComponentHashes(compoMap, buildGroups)
    if (hashCalculationErrors) {
        for (const err of hashCalculationErrors) { console.error(colors.red(err.e)); } return exit(1)
    }
    if (!options.tag) {
        options.tag = `_tmp-${crypto.randomBytes(8).toString('hex')}`
        console.warn(colors.yellow(`WARNING; --tag option was not given for the build, using temporary tag '${options.tag}'`))
    }
    const buildErrors = await buildAllGroups(options, compoMap, buildGroups, configChain)
    if (buildErrors) {
        for (const err of buildErrors) { console.error(colors.red(err.e)); } return exit(1)
    }
});

cli.parse();

globalRoot.on('unhandledRejection', (e: Error, prom) => {
    console.error(e);
});
