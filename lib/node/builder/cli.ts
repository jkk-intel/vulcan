import { Command } from 'commander';
import { getDependencyErrors, getComponentsMap, orderBuildsInGroups, calculateComponentHashes, findBuilderConfig, buildAllGroups, getActiveBuilderConfig, resolveBuildEnvironment, BuilderCustomOptions, runCommand, matchFiles, setFileContent, killLogTail, existingPath, nohupDisown, getFileContent } from './builder';
import { globalRoot } from 'ts-basis';
import { spawn } from 'child_process'
import * as crypto from 'crypto';
import * as pathlib from 'path'
import * as fs from 'fs'
import { v4 as uuidv4 } from 'uuid'
import packageJSON from '../package.json'
const colors = require('colors/safe')

const cli = new Command()
const version = packageJSON.version
const binName = Object.keys(packageJSON.bin)[0]

cli.name(binName)
    .description(`advanced project components building framework`)
    .version(version);

cli.command('build')
.option('--tag <tag>', 'image tag for the build set (branch name or run number). If not given, the tag is auto-generated')
.option('--working-directory <workingDirectory>', 'change directory to specified dir before running the build')
.option('--head-branch <headBranch>', 'working branch name for precommit')
.option('--base-branch <baseBranch>', 'base branch for the working branch')
.option('--no-prebuilt', 'disables build skipping when prebuilt images with the same shasum is detected')
.option('--no-cache', 'disables docker cache and build all layers')
.option('--precommit-context <precommitContext>', 'context metadata for precommit (PR) flow')
.option('--ci', 'whether the current build is during CI flow')
.option('--background', 'run build process as background')
.option('--wait', 'wait indefinitely for the background build to finish')
.description(`build components with parameters, v1`)
.action(async (options: BuilderCustomOptions) => {
    if (options.background) {
        await setFileContent(`build.all.log`, '')
        nohupDisown(process.argv.filter(a => a !== '--background' && a !== '--wait'))
        return
    }
    if (options.wait) {
        const proc = spawn(`tail`, ['-f', '-n', '+1', 'build.all.log'], { stdio: 'inherit' })
        proc.on('close', async code => {
            const { data } = await getFileContent(`build.all.result.log`)
            return process.exit(data.trim() === 'SUCCESS' ? 0 : 1)    
        })
        return
    }
    options.logStream = fs.createWriteStream(`build.all.log`);
    options.log = (str: string) => { console.log(str); options.logStream.write(str + '\n'); }
    options.error = (str: string) => { console.error(str); options.logStream.write(str + '\n'); }
    options.warn = (str: string) => { console.warn(str); options.logStream.write(str + '\n'); }
    const exit = async (code = 0) => {
        await setFileContent(`build.all.result.log`, code === 0 ? 'SUCCESS' : 'FAILURE')
        await killLogTail(`build.all.log`)
        if (!options.logStream.closed) { options.logStream.close() }
        setTimeout(() => process.exit(code), 500) as any
    }
    try {
        options.log('')
        options.log(colors.gray(`build invoked with following options: {`))
        for (const optionName of Object.keys(options)) {
            const paramType = typeof options[optionName]
            if (paramType !== 'boolean' && paramType !== 'string') {
                continue
            }
            options.log(colors.gray(`   ${optionName}: ${colors.cyan(options[optionName])}`))
        }
        options.log(colors.gray('}'))
        const configChain = await findBuilderConfig()
        const activeConfig = getActiveBuilderConfig(configChain)
        await resolveBuildEnvironment(activeConfig, options)
        activeConfig.start_time = Date.now()
        const [ compoMap, fileErrors ] = await getComponentsMap(options);
        if (fileErrors) {
            for (const err of fileErrors) { options.error(colors.red(err.e)); } return exit(1)
        }
        const depErrors  = getDependencyErrors(compoMap);
        if (depErrors) {
            for (const err of depErrors) { options.error(colors.red(err.e)); } return exit(1)
        }
        const buildGroups = orderBuildsInGroups(compoMap);
        const hashCalculationErrors = await calculateComponentHashes(options, compoMap, buildGroups)
        if (hashCalculationErrors) {
            for (const err of hashCalculationErrors) { options.error(colors.red(err.e)); } return exit(1)
        }
        if (!options.tag) {
            options.tag = `_tmp-${crypto.randomBytes(8).toString('hex')}`
            options.warn(colors.yellow(`WARNING; --tag option was not given for the build, using temporary tag '${options.tag}'`))
        }
        const buildErrors = await buildAllGroups(options, compoMap, buildGroups, configChain)
        if (buildErrors) {
            for (const err of buildErrors) { options.error(colors.red(err.e)); } return exit(1)
        }
    } catch (e) {
        options.error(colors.red(e));
        return exit(1)
    }
    exit(0)
});

const diff = cli.command('diff').description('lib for utils regarding changed files');

diff.command('show')
.option('--count', 'return the number of changed files instead of showing the list')
.action(async (options: { count: boolean }) => {
    const [code, stdout, stderr, e] = await runCommand(`git diff --name-only -r HEAD^1 HEAD`)
    const files = (code === 0) ? stdout.split('\n').filter(a => a.trim()) : []
    if (options.count) {
        console.log(files.length)
    } else {
        files.forEach(file => console.log(file))
    }
});

diff.command('match')
.option('--exclude <exclude>', 'glob pattern to exclude', arrayType, [])
.option('--count', 'return the number of matched files instead of showing the list')
.argument('<patterns...>', 'glob pattern to match the diff files with')
.action(async (patterns: string[], options: { exclude: string[], count: boolean }) => {
    const [code, stdout, stderr, e] = await runCommand(`git diff --name-only -r HEAD^1 HEAD`)
    const files = (code === 0) ? stdout.split('\n').filter(a => a.trim()) : []
    const matchedFiles = await matchFiles(files, patterns, options.exclude)
    if (options.count) {
        console.log(matchedFiles.length)
    } else {
        matchedFiles.forEach(file => console.log(file))
    }
});

const picker = cli.command('pick').description('lib for utils regarding choosing numbers within given ranges')

picker.command('modulo')
.argument('<modulo>', 'pool size for the pick')
.argument('[input]', "<integer> | <hexadecimal> | 'commit-sha' | 'random'")
.option('--natural', 'natural number counting; instead of [0-m) range, do [1-m]')
.option('--add <add>', '[-/+] integer to add to the picked result')
.action(async (modulo: string, input: string, options: { natural: boolean, add: string }) => {
    if (!input || input === 'random') {
        input = uuidv4().split('-').join('')
    } else if (input === 'commit-sha') {
        const [code, stdout, stderr, e] = await runCommand(`git rev-parse HEAD`)
        if (code !== 0) {
            input = uuidv4().split('-').join('')
            console.error(colors.red(`Unable to get commit sha: ${stderr}`))
            process.exit(1)
        }
        input = stdout.trim()
    }
    let hexValue = ''
    if (!isNaN(parseInt(input.slice(0, 8), 16))) {
        hexValue = input.split('').reverse().join('')
    } else if (!isNaN(parseInt(input.slice(0, 15), 10))) {
        hexValue = parseInt(input.slice(0, 15), 10).toString(16)
    } else {
        console.error(colors.red(`Bad input value '${input}', ` +
                                 `options: <integer> | <hexadecimal> | 'commit-sha' | 'random'`))
        process.exit(1)
    }
    const num = Math.abs(parseInt(hexValue, 16))
    const moduloNum = parseInt(modulo, 10)
    if (isNaN(moduloNum) || !moduloNum || moduloNum < 0) {
        console.error(colors.red(`Bad modulo value '${modulo}', ` +
                                 `must be a natural number`))
        process.exit(1)
    }
    const picked = num % moduloNum
    const naturalApplied = options.natural ? picked + 1 : picked
    const addApplied = !isNaN(parseInt(options.add, 10)) ?
                        naturalApplied + parseInt(options.add, 10) : naturalApplied
    console.log(addApplied)
});

cli.parse();

globalRoot.on('unhandledRejection', (e: Error, prom) => {
    console.error(e);
});

function arrayType(value, previous) {
    return previous.concat([value]);
}
