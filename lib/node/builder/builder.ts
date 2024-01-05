import * as fs from 'fs'
import * as yaml from 'js-yaml'
import * as pathlib from 'path'
import * as crypto from 'crypto'
import * as readline from 'readline'
import * as os from 'os'
import { ExecOptions, SpawnOptions, exec, spawn } from 'child_process'
import { promise } from 'ts-basis'
import { BuilderConfig, BuilderConfigChain, ComponentManifest, ComponentManifestMap, TypedBuilderConfig } from './model'
const fg = require('fast-glob')
const colors = require('colors/safe')

const defaultExcludes = [
    '**/.DS_Store',
    '**/.hash*',
    '**/node_modules',
    '**/generated-sources',
]
type FileError = {file: any; e: Error; data?: any; isWarning?: boolean; };
type GlobResult<T = string[]> = [T, FileError[]]
let currentOutputOwner = ''

export type BuilderCustomOptions = {
    tag?: string,
    ci?: boolean,
    workingDirectory?: string,
    baseBranch?: string,
    headBranch?: string,
    prebuilt?: boolean,
    cache?: boolean,
}

export async function buildAllGroups(options: BuilderCustomOptions, compoMap: ComponentManifestMap, buildGroups: ComponentManifest[][], configChain?: BuilderConfigChain) {
    if (!configChain) {
        configChain = await findBuilderConfig()
    }
    setFileContent(`build.all.map.log`, JSON.stringify(buildGroups, null, 4))
    const startTime = Date.now()
    const buildAllLogFile = fs.createWriteStream(`build.all.log`);
    const config = getActiveBuilderConfig(configChain)
    const buildEnv = config.is_postcommit ? 'POST_COMMIT' : 'PRE_COMMIT'
    const allErrors: FileError[] = []
    const end = () => {
        const dur = ((Date.now() - startTime) / 1000).toFixed(1)
        forkedConsoleLog(`Finished in ${colors.yellow(dur + 's')}`)
        if (allErrors.length) {
            forkedConsoleLog(`Overall result: ${colors.red('FAILED')}\n`)
        } else {
            forkedConsoleLog(`Overall result: ${colors.green('SUCCESS')}\n`)
        }
        buildAllLogFile.close()
        return allErrors.length ? allErrors : null;
    }
    const forkedConsoleLog = (str: string) => { console.log(str); buildAllLogFile.write(str + '\n'); }
    forkedConsoleLog('')
    forkedConsoleLog(colors.gray(`INVOKE_ENV: ${colors.cyan(buildEnv)}`))
    forkedConsoleLog(colors.gray(`HEAD_BRANCH: ${colors.cyan(config.head_branch)}`))
    forkedConsoleLog(colors.gray(`BASE_BRANCH: ${colors.cyan(config.base_branch)}`))
    forkedConsoleLog('')
    forkedConsoleLog(colors.gray(`Building components in the following group order:`))
    let groupIndex = 0
    for (const buildGroup of buildGroups) {
        ++groupIndex
        forkedConsoleLog(colors.green((`[${'group-' + groupIndex}]`)))
        for (const compo of buildGroup) {
            const name = `${compo.name}${compo.project ? ` (${compo.project})`: ''}`
            forkedConsoleLog(`    ${colors.yellow(name)}${colors.gray('@'+compo.hash.slice(1))}`)
        }
    }
    forkedConsoleLog('')
    for (const buildGroup of buildGroups) {
        const groupPrepProcesses = buildGroup.map(compoManifest => buildPrepComponent(options, compoMap, compoManifest, configChain, allErrors))
        await Promise.allSettled(groupPrepProcesses)
        if (allErrors.length) {
            return end()
        }
        const groupBuildProcesses = buildGroup.map(compoManifest => buildComponent(options, compoMap, compoManifest, configChain, allErrors, buildAllLogFile))
        await Promise.allSettled(groupBuildProcesses)
        if (allErrors.length) {
            return end()
        }
        forkedConsoleLog('')
    }
    return end()
}

function buildComponent(options: BuilderCustomOptions, compoMap: ComponentManifestMap, compo: ComponentManifest, configChain: BuilderConfigChain, errors?: FileError[], buildAllLogFile?: fs.WriteStream) {
    if (!errors) { errors = []; }
    const { tag } = options
    const config = getActiveBuilderConfig(configChain)
    if (compo.builder === 'docker') {
        return promise<boolean>(async resolve => {
            const startTime = Date.now()
            let resolved = false
            const tryResolve = (v: boolean) => resolved ? null : (resolved = true) && resolve(v)
            const forkedConsoleLog = (str: string) => { console.log(str); buildAllLogFile.write(str + '\n'); }

            const cliArgs: string[] = []
            if (compo.docker.debug) { cliArgs.push('-D') }
            cliArgs.push(
                'buildx', 'build',
                '--progress=plain',
                '--pull',
                '--push',
            )
            if (!options.cache || compo.no_cache) { cliArgs.push('--no-cache'); }
            const allFullImagePaths: string[] = []

            const dockerfile = compo.docker?.dockerfile ?? 'Dockerfile'
            const dockerfileAbspath = pathlib.join(compo.dir, dockerfile)
            cliArgs.push('--file', dockerfileAbspath)

            if (compo.docker.target) { cliArgs.push('--target', compo.docker.target) }

            const ephemeralImageHashedTag = getEphemeralComponentFullpath(compo, config)
            const ephemeralImageCustomTag = getEphemeralComponentFullpath(compo, config, tag)

            let chosenBuilder: string = ''
            if (stringArray(config.docker?.remote_builders).length) {
                const builders = stringArray(config.docker?.remote_builders)
                chosenBuilder = builders[0]
                cliArgs.push('--builder', chosenBuilder)
            }

            cliArgs.push('--tag', ephemeralImageHashedTag)
            cliArgs.push('--tag', ephemeralImageCustomTag)
            allFullImagePaths.push(ephemeralImageHashedTag, ephemeralImageCustomTag)

            const shouldPublish = (flag: boolean | "ci-only") => flag === true || (flag === 'ci-only' && options.ci)

            if (
                !compo.unpublished &&
                config.is_precommit &&
                shouldPublish(config.docker?.precommit?.publish) &&
                stringArray(config.docker?.registry?.precommit).length
            ) {
                const publishPaths = getPrecommitComponentPublishPaths(compo, config)
                for (const publishPath of publishPaths) {
                    const fullPath = `${publishPath}:${tag}`
                    cliArgs.push('--tag', fullPath)
                    allFullImagePaths.push(fullPath)
                }
            }

            if (
                !compo.unpublished &&
                config.is_postcommit &&
                shouldPublish(config.docker?.postcommit?.publish) &&
                stringArray(config.docker?.registry?.postcommit).length
            ) {
                const publishPaths = getPostcommitComponentPublishPaths(compo, config)
                if (config.docker?.postcommit?.publish) {
                    for (const publishPath of publishPaths) {
                        const fullPath = `${publishPath}:${tag}`
                        cliArgs.push('--tag', fullPath)
                        allFullImagePaths.push(fullPath)
                    }
                }
                if (shouldPublish(config.docker?.postcommit?.publish_latest)) {
                    for (const publishPath of publishPaths) {
                        const fullPath = `${publishPath}:latest-postcommit`
                        cliArgs.push('--tag', fullPath)
                        allFullImagePaths.push(fullPath)
                    }
                }
            }

            let procHeaderBase = `--------- ${compo.fullname} ----------------------`
            if (procHeaderBase.length < 80) {
                procHeaderBase += '-'.repeat(80 - procHeaderBase.length)
            }
            const procHeader = `${colors.gray(procHeaderBase)}`
            const sectionSwitchPending = () => currentOutputOwner !== procHeader
            const rectifyOutputSection = () => {
                if (sectionSwitchPending()) {
                    currentOutputOwner = procHeader
                    forkedConsoleLog('')
                    forkedConsoleLog(procHeader)
                }
            }
            const pushedPaths = allFullImagePaths.map(img => `    ${colors.green(img)}`).join('\n')
            const announcePushes = () => {
                rectifyOutputSection()
                forkedConsoleLog(`Successfully published ${colors.cyan(compo.fullname)} to:\n${pushedPaths}\n`)
            }

            // Check prebuilt
            if (options.prebuilt && !compo.no_prebuilt) {
                const tmpfile = `${os.tmpdir()}/${compo.fullname.replace(/\//g, '_')}.Dockerfile`
                await setFileContent(tmpfile, `FROM ${ephemeralImageHashedTag}`)
                let checkerCmd = `docker buildx build `
                checkerCmd += chosenBuilder ? ` --builder '${chosenBuilder}' ` : ''
                checkerCmd += allFullImagePaths.map(img => ` --tag '${img}'`).join(' ')
                checkerCmd += ` --pull --push -f '${tmpfile}' . `
                const [ prebuiltResult ] = await runCommand(checkerCmd)
                const prebuiltExists = prebuiltResult === 0
                if (prebuiltExists) {
                    rectifyOutputSection()
                    forkedConsoleLog(`${colors.yellow(`[PREBUILT]`)} ${colors.cyan(compo.fullname)}${colors.gray('@'+compo.hash.slice(1))}` +
                                    ` has been published before, skipping building.`)
                    announcePushes()
                    return tryResolve(null)
                }
            }

            const buildArgsFinal: { [argname: string]: string; } = {}
            const addBuildArgs = () => {
                const buildArgsCommon = copy(compo.docker?.build_args_inherited) ?? {}
                const buildArgsTemp = copy(compo.docker?.build_args_temp) ?? {}
                const buildArgsOverride = copy(compo.docker?.build_args) ?? {}
                Object.assign(buildArgsFinal, buildArgsCommon)
                Object.assign(buildArgsFinal, buildArgsTemp)
                Object.assign(buildArgsFinal, buildArgsOverride)
                for (const buildArgName of Object.keys(buildArgsFinal)) {
                    cliArgs.push('--build-arg', `${buildArgName}=${buildArgsFinal[buildArgName]}`)
                }
            }; addBuildArgs()

            const addCacheOpts = async () => {
                if (!stringArray(config.docker?.registry?.cache).length) {
                    return
                }
                const defaultCacheToOpts = 'mode=max,ignore-error=true,compression=zstd,compression-level=1,image-manifest=true'
                const cacheRegistries = stringArray(config.docker?.registry?.cache);
                const cacheFromResolves: Promise<[boolean, string, string]>[] = []
                for (const cacheRegistry of cacheRegistries) {
                    const imagePath = `${cacheRegistry}/${compo.fullname}`.toLowerCase()
                    const imageRefBase = `${imagePath}:${config.base_branch.replace(/\//g, '__')}`.toLowerCase()
                    const imageRefHead = `${imagePath}:${config.head_branch.replace(/\//g, '__')}`.toLowerCase()
                    cacheFromResolves.push(dockerCacheFromResolve(imageRefBase))
                    cacheFromResolves.push(dockerCacheFromResolve(imageRefHead))
                    cliArgs.push('--cache-to', `type=registry,ref=${imageRefHead},${defaultCacheToOpts}`.toLowerCase())
                }
                const cacheLookUpSettleds = await Promise.allSettled(cacheFromResolves)
                for (const cacheLookUpSettled of cacheLookUpSettleds) {
                    if (cacheLookUpSettled.status === 'rejected') {
                        continue
                    }
                    const [imageExists, imagePath, stderr] = cacheLookUpSettled.value
                    if (!imageExists) {
                        rectifyOutputSection()
                        forkedConsoleLog(colors.gray(`[CACHE_MISS] cache image not found: ${stderr.trim().split('\n')[0]}`))
                        continue
                    }
                    cliArgs.push('--cache-from', `type=registry,ref=${imagePath}`)
                }
            }; await addCacheOpts()

            const contextDir = compo.docker.context ? pathlib.join(compo.dir, compo.docker.context) : compo.dir
            cliArgs.push(contextDir)

            const streamFile = `build.${compo.name_safe}.log`
            const logFile = fs.createWriteStream(streamFile);
            logFile.write(`docker buildx build ` + 
                     `${cliArgs.slice(2).map(a => a.startsWith('--') ? a : `${a}\n    `).join(' ')}` +
                     `\n\n`)
            
            const spawnOpts: SpawnOptions = {}
            const proc = spawn('docker', cliArgs, spawnOpts)

            let inErrorSection = false
            const elapsed = () => {
                const dur = Math.floor((Date.now() - startTime)/ 1000)
                const date = new Date(null);
                date.setSeconds(dur);
                return `[${date.toISOString().slice(11, 19)} ${compo.fullname}]`;
            }
            const isStepsLine = (lit: string[]) => {
                return (
                    (lit[1] && lit[1].charAt(0) === '[' && parseInt(lit[1].charAt(1)) >= 0) ||
                    (lit[2] && lit[2].endsWith(']') && parseInt(lit[2].replace(/\//g, '')) >= 0)
                )
            }
            const isErrorLine = (lit: string[]) => lit[0] === 'ERROR:'  || lit[1] === 'ERROR:'
            const isAppErrorLine = (line: string) => { const pos = line.toLowerCase().indexOf('error:'); return pos >= 0 && pos < 10; }
            const shouldIgnore = (line: string) => line.indexOf(' registry cache ') >= 0
            const echoLine = (line: string, isError = false) => {
                rectifyOutputSection()
                if (isError) {
                    forkedConsoleLog(colors.red(`${elapsed()}      ${line}    `))
                } else {
                    forkedConsoleLog(`${elapsed()}      ${line}`)
                }
            }
            const handleLine = line => {
                const lit = line.split(' ').filter(a => a);
                if (line.charAt(0).startsWith('#')) {
                    inErrorSection = false
                }
                if (lit[1] === 'CACHED') {
                    return echoLine(line)
                }
                if (isStepsLine(lit)) {
                    return echoLine(line)
                } else if (isErrorLine(lit) && !shouldIgnore(line)) {
                    inErrorSection = !inErrorSection
                    return echoLine(line, true)
                } else if (inErrorSection) {
                    return echoLine(line, true)
                } else if (isAppErrorLine(line) && !shouldIgnore(line)) {
                    return echoLine(line, true)
                }
            }

            echoLine(`${colors.green('STARTED')} '${compo.fullname}'`)
            for (const argname of Object.keys(buildArgsFinal)) {
                echoLine(`    ARG ${colors.cyan(argname)}='${buildArgsFinal[argname]}'`)
            }

            const stdoutReader = readline.createInterface({
                input: proc.stdout,
                terminal: false,
            }).on('line', line => {
                logFile.write(line)
                logFile.write('\n')
                handleLine(line)
            });

            const stderrReader = readline.createInterface({
                input: proc.stderr,
                terminal: false,
            }).on('line', line => {
                logFile.write(line)
                logFile.write('\n')
                handleLine(line)
            });

            proc.on('close', code => {
                stdoutReader.close()
                stderrReader.close()
                const isSuccessful = code === 0
                const dur = ((Date.now() - startTime) / 1000).toFixed(1)
                echoLine(
                    isSuccessful ?
                        `${colors.green('FINISHED')} '${compo.fullname}' (${dur}s)` :
                        `${colors.red('FAILED')} '${compo.fullname}' (${dur}s), exitcode=${code}`
                )
                if (!isSuccessful) {
                    errors.push({
                        file: dockerfileAbspath,
                        e: new Error(`ERROR; docker build failed for component '${compo.name}'`+
                                     `\n(more info at ${streamFile}:1:1):\n`)
                    })
                } else {
                    announcePushes()
                }
                tryResolve(isSuccessful)
            })
        })
    }
}

async function buildPrepComponent(options: BuilderCustomOptions, compoMap: ComponentManifestMap, compo: ComponentManifest, configChain: BuilderConfigChain, errors?: FileError[]) {
    if (!errors) { errors = []; }
    const config = getActiveBuilderConfig(configChain)
    if (compo.builder === 'docker') {
        const dockerfile = compo.docker?.dockerfile ?? 'Dockerfile'
        const dockerfileAbspath = pathlib.join(compo.dir, dockerfile)
        const { data } = await getFileContent(dockerfileAbspath, [])
        if (!data) {
            errors.push({
                file: dockerfileAbspath,
                e: new Error(`ERROR; Unable to find docker file at '${dockerfile}'`)
            })
            return
        }
        if (!compo.docker) {
            compo.docker = {}
        }
        if (!compo.docker.image_name) {
            compo.docker.image_name = compo.name
        }
        compo.docker.image_name = compo.docker.image_name.toLowerCase()
        if (config.docker?.build_args) {
            compo.docker.build_args_inherited = copy(config.docker?.build_args)
        }
        if (compo.depends_on?.length) {
            let linesWithExtendFrom: string[] = []
            let beforeFrom = true
            const lines = data.split('\n')
            let lineNumber = 0
            for (const line of lines) {
                ++lineNumber
                if (line.startsWith('FROM')) {
                    // only interested in ARGs before FROM
                    beforeFrom = false
                    continue
                }
                if (line.indexOf('ARG EXTEND_FROM_') >= 0) {
                    if (beforeFrom) {
                        linesWithExtendFrom.push(line)    
                    } else {
                        errors.push({
                            file: dockerfileAbspath,
                            e: new Error(`ERROR; Dockerfile 'ARG EXTEND_FROM' usage cannot exist after the first FROM directive` +
                                        ` (near '${line}' at ${dockerfileAbspath}:${lineNumber})`)
                        })
                    }
                }
            }
            const depNames = linesWithExtendFrom.map(line => line.replace('ARG EXTEND_FROM_', '').split('=')[0].split(' ')[0])
            for (const depName of depNames) {
                const depNameOriginal = depName.replace(/__/g, '/')
                const depNameHyphen = depNameOriginal.replace(/_/g, '-')
                if (compo.depends_on.indexOf(depNameOriginal) === -1 && compo.depends_on.indexOf(depNameHyphen) === -1) {
                    errors.push({
                        file: dockerfileAbspath,
                        e: new Error(`ERROR; component dockerfile is using 'EXTEND_FROM_${depName}' ` +
                                     `but the parent component '${depNameOriginal}' is missing from dependency declaration in ` +
                                     `'depends_on' in the component manifest '${compo.manifest_path}'`)
                    })
                    continue
                }
                if (!compo.docker.build_args_temp) { compo.docker.build_args_temp = {} }
                const parentCompoName = compo.depends_on.indexOf(depNameOriginal) >= 0 ? depNameOriginal : depNameHyphen
                const parentCompo: ComponentManifest = findParentComponentByName(parentCompoName, compoMap)
                if (!parentCompo) {
                    errors.push({
                        file: dockerfileAbspath,
                        e: new Error(`ERROR; component dockerfile is using 'EXTEND_FROM_${depName}' ` +
                                     `but the parent component '${parentCompoName}' not found on the component map ` + 
                                     `while parsing '${compo.manifest_path}'`)
                    })
                    continue
                }
                compo.docker.build_args_temp[`EXTEND_FROM_${depName}`] = getEphemeralComponentFullpath(parentCompo, config)
            }
            if (errors.length) {
                return
            }
        }
    }
}

export async function getComponentsMap(currentPath = '.'): Promise<GlobResult<ComponentManifestMap>> {
    const map: ComponentManifestMap = {};
    const errors: FileError[] = [];
    console.log(colors.gray(`\ntrying to find buildable components in '${process.cwd()}' ...`))
    const manifestPatterns = [
        `${currentPath}/**/*.component.yml`,
        `${currentPath}/**/*.component.yaml`,
        `${currentPath}/**/*.builder.yml`,
        `${currentPath}/**/*.builder.yaml`,
    ]
    await getGlobMatched('.', manifestPatterns, [], errors, async (file) => {
        try {
            const { data } = await getFileContent(file, errors)
            const compo = yaml.load(data) as ComponentManifest
            compo.manifest_path = file
            compo.dir = pathlib.dirname(file)
            if (!compo.name) {
                errors.push({file, e: new Error(`ERROR: component name not found\n    ${file}`)})
                return
            }
            if (compo.name.indexOf('-') >= 0 && compo.name.indexOf('_') >= 0) {
                errors.push({file, e: new Error(`ERROR: component name cannot have both hyphen '-' and underscore '_'\n    ${file}`)})
                return
            }
            compo.name_hyphen = compo.name.replace(/_/g, '-')
            if (!compo.project) { compo.project = ''; }
            if (notSet(compo.timeout)) { compo.timeout = 1800; }
            compo.fullname = compo.project ? `${compo.project}/${compo.name_hyphen}` : compo.name_hyphen
            compo.name_safe = compo.fullname.replace(/\//g, '__').toLowerCase()
            if (map[compo.fullname]) {
                errors.push({file, e: new Error(
                    `ERROR: component name '${compo.fullname}' exists already\n    at ${file} ` +
                    `(registered by ${map[compo.fullname].manifest_path})`)})
                return
            }
            map[compo.fullname] = compo
            const manigestRelpath = pathlib.relative(process.cwd(), compo.manifest_path)
            console.log(colors.gray(`\    found component ${colors.green(compo.name)} (${manigestRelpath})`))
            if (compo.depends_on) { compo.depends_on = stringArray(compo.depends_on) }
            if (!compo._circular_dep_checker) { compo._circular_dep_checker = [] }
        } catch (e) {
            errors.push({file, e: new Error(`ERROR: unable to yaml parse\n    ${file}: ${e}`)})
            return
        }
    })
    if (errors.length) {
        return [null, errors]
    }
    return [map, null]
}

export function getDependencyErrors(map: ComponentManifestMap) {
    const errors: FileError[] = [];
    for (const fullname of Object.keys(map)) {
        const compo = map[fullname];
        if (!compo.depends_on) { continue; }
        for (const depname of compo.depends_on) {
            const depfullname = depname.indexOf('/') === -1 ? 
                                `${compo.project ? compo.project + '/' : ''}${depname}` : depname;
            const dep = map[depfullname];
            if (!dep) {
                errors.push({file: compo.manifest_path, e: new Error(
                    `ERROR: dependency '${depfullname}' not found\n    at ${compo.manifest_path}`)});
                continue;
            }
            compo._circular_dep_checker.push(dep);
        }
    }
    try {
        JSON.stringify(map);
        return errors.length ? errors : null;
    } catch (e) {
        errors.push({
            file: null,
            e: new Error(`ERROR: components manifest with a circular dependency`),
            data: map,
        });
        return errors;
    }
}

export function orderBuildsInGroups(mapArg: ComponentManifestMap) {
    const totalList: ComponentManifest[][] = [];
    const map = { ...mapArg }; // clone
    const alreadyBuilt: { [fullname: string]: ComponentManifest } = {};
    // extract root level dependencies
    let buildGroup = 0;
    for (const fullname of Object.keys(map)) {
        const compo = map[fullname];
        if (!compo.depends_on || compo.depends_on.length === 0) {
            if (!totalList[0]) { totalList.push([]); }
            totalList[0].push(compo);
            alreadyBuilt[fullname] = compo;
            delete map[fullname];
        }
    }
    while (Object.keys(map).length > 0) {
        totalList.push([]); buildGroup++;
        const toBeBuiltInThisGroup: string[] = [];
        for (const fullname of Object.keys(map)) {
            const compo = map[fullname];
            let allDepsReady = true;
            for (const dep of compo._circular_dep_checker) {
                if (!alreadyBuilt[dep.fullname]) { allDepsReady = false; break; }
            }
            if (!allDepsReady) { continue; }
            toBeBuiltInThisGroup.push(fullname);
        }
        for (const fullname of toBeBuiltInThisGroup) {
            const compo = map[fullname];
            totalList[buildGroup].push(compo);
            alreadyBuilt[fullname] = compo;
            delete map[fullname];
        }
        if (!toBeBuiltInThisGroup.length) {

        }
    }
    for (const fullname of Object.keys(alreadyBuilt)) {
        const compo = alreadyBuilt[fullname];
        if (compo._circular_dep_checker) { delete compo._circular_dep_checker; }
    }
    return totalList;
}

export async function calculateComponentHashes(compoMap: ComponentManifestMap, buildGroups: ComponentManifest[][]) {
    const components: { filteredSources: GlobResult, manifest: ComponentManifest }[] = []
    const allErrors: FileError[] = []
    buildGroups.forEach(buildGroup => buildGroup.forEach(compo => {
        if (!compo.src || compo.src.length === 0) {
            compo.src === '.'
        }
        compo.src = stringArray(compo.src)
        components.push({
            filteredSources: null,
            manifest: compo,
        })
    }))
    const prebuildScriptCount = components.filter(compo => compo.manifest.prebuild_script).length
    if (prebuildScriptCount) {
        const prebuildScriptRunPromise: Promise<CommandResult>[] = []
        const prebuildScriptMetadata: { script: string, compo: ComponentManifest }[] = []
        console.log('\n' + colors.green('[prebuild_script]') + colors.gray(` total ${colors.yellow(prebuildScriptCount)} found, running ...`))
        for (const compoData of components) {
            const compo = compoData.manifest
            if (compo.prebuild_script) {
                const scriptProc = runCommand(compo.prebuild_script, { cwd: compo.dir })
                prebuildScriptMetadata.push({ script: compo.prebuild_script, compo })
                console.log(`${colors.gray(`${colors.yellow(compo.fullname)}:`)} ${colors.cyan(compo.prebuild_script)}`)
                prebuildScriptRunPromise.push(scriptProc)
            }
        }
        console.log('')
        const prebuildSettled = await Promise.allSettled(prebuildScriptRunPromise)
        for (let i = 0; i < prebuildSettled.length; ++i) {
            const settled = prebuildSettled[i]
            const scriptMetadata = prebuildScriptMetadata[i]
            if (settled.status === 'rejected') {
                allErrors.push({
                    file: scriptMetadata.compo.manifest_path,
                    e: new Error(`ERROR; unhandled rejection while running command '${scriptMetadata.script}'`+
                                ` during prebuild script of '${scriptMetadata.compo.fullname}': ${settled.reason}`),
                })
                continue
            }
            const [ code, stdout, stderr, e ] = settled.value
            const logFile = `build.pre.${scriptMetadata.compo.name_safe}.log`
            setFileContent(logFile, [
                `COMMAND: ${scriptMetadata.script}`,
                `ERROR_OBJECT: ${e ?? ''}`,
                `========================= stdout ==============================`,
                stdout,
                '', '', '', '',
                `========================= stderr ==============================`,
                stderr,
                '', '', '', '',
            ].join('\n'))
            if (code !== 0) {
                allErrors.push({
                    file: scriptMetadata.compo.manifest_path,
                    e: new Error(`ERROR; unhandled rejection while running command '${scriptMetadata.script}'`+
                                ` during prebuild script of '${scriptMetadata.compo.fullname}' ` + 
                                `\n(more info at ${logFile}:1:1):\n${e?.message ?? ''}`),
                })
                continue
            }
        }
        if (allErrors.length) {
            return allErrors
        }
    }

    // detect manifest errors first
    for (const compoData of components) {
        const compo = compoData.manifest
        const relPath = pathlib.relative(process.cwd(), compo.dir)
        const emptyMatchWarningContext = `parsing 'src' in '${relPath}/${pathlib.basename(compo.manifest_path)}'`
        const filteredResult = await getGlobMatched(compo.dir, compo.src as string[], compo.ignore, [], null, emptyMatchWarningContext)
        compoData.filteredSources = filteredResult
        const [ _, errors ] = filteredResult
        if (errors) {
            for (const error of errors) {
                error.e.message = (`ERROR; error detected in the build manifest ` +
                            `of component '${compo.name}': one of listed sources (${stringArray(compo.src).join(', ')}) ` +
                            `cannot be found, at (${compo.dir}/${pathlib.basename(compo.manifest_path)})`)
                allErrors.push(error)
            }
        }
    }
    if (allErrors.length) {
        return allErrors
    }
    for (const compoData of components) {
        const compo = compoData.manifest
        const [ validPaths ] = compoData.filteredSources
        validPaths.push(compo.manifest_path)
        if (compo.builder === 'docker') {
            // if builder is docker, the component dockerfile is also a default dependency 
            const dockerfile = compo.docker?.dockerfile ?? 'Dockerfile'
            const dockerfileAbspath = pathlib.join(compo.dir, dockerfile)
            validPaths.push(dockerfileAbspath)
        }
        const statProms = validPaths.map(path => entityStat(path))
        const dirProms: Promise<GlobResult>[] = []
        const allFiles: string[] = []
        const statResolved = await Promise.allSettled(statProms)
        for (const gitObjectResult of statResolved) {
            if (gitObjectResult.status !== 'fulfilled') {
                allErrors.push({
                    file: null,
                    e: new Error(gitObjectResult.reason),
                })
                continue
            }
            if (!gitObjectResult.value) {
                continue
            }
            const [ path, pathStat ] = gitObjectResult.value
            if (pathStat.isDirectory()) {
                const errors: FileError[] = []
                dirProms.push(getGlobMatched(compo.dir, [`${path}/**/*`], compo.ignore, errors))
            } else {
                allFiles.push(path)
            }
        }
        const dirsSettled = await Promise.allSettled(dirProms)
        for (const dirSettle of dirsSettled) {
            if (dirSettle.status !== 'fulfilled') {
                allErrors.push({
                    file: null,
                    e: new Error(dirSettle.reason),
                })
                continue
            }
            const [ paths, errors ] = dirSettle.value
            if (errors) {
                for (const e of errors) {
                    allErrors.push(e)
                }
            }
            allFiles.push(...paths)
        }
        const allUniqueFiles = uniqueStringArray(allFiles).sort((a, b) => a.localeCompare(b))
        const settledSha = await Promise.allSettled(allUniqueFiles.map(file => shasumFile(file)))
        const fileShasums: string[] = []
        settledSha.forEach(shaResult => {
            if (shaResult.status === 'fulfilled') {
                const [ file, shasum ] = shaResult.value
                fileShasums.push(shasum)
            }
        })
        const dependsOnShasums: string[] = []
        compo.depends_on?.forEach(parentComponentName => {
            const parentCompo: ComponentManifest = findParentComponentByName(parentComponentName, compoMap)
            dependsOnShasums.push(`dependency; ${parentCompo.fullname} @${parentCompo.hash_long}`)
        })
        const affectedBy = [
            ...dependsOnShasums,
            ...allUniqueFiles.map((file, i) => `file; ${pathlib.relative(compo.dir, file)} @${fileShasums[i]}`)
        ]
        const totalSha = shasumStringArray(compo.fullname, [...dependsOnShasums, ...fileShasums])
        compo.affected_by = affectedBy
        compo.hash_long = totalSha
        compo.hash = `_${totalSha.slice(0, 24)}`
    }
    if (allErrors.length) {
        return allErrors
    }
    return null
}

function getGlobMatched(
    workingDirectory: string,
    globexprs: string[],
    ignore: string[],
    errors?: FileError[],
    forEachFile?: <T=any>(file: string, errors: FileError[]) => Promise<T | void>,
    emptyMatchWarningContext = '',
): Promise<GlobResult> {
    if (!errors) { errors = []; }
    if (!ignore) { ignore = []; }
    ignore = stringArray(ignore)
    return promise<GlobResult>(async resolve => {
        if (!globexprs) {
            return resolve([[], errors])
        }
        const globOnly = globexprs.filter(expr => expr.indexOf('*') >= 0)
        const rawPaths = globexprs.filter(expr => expr.indexOf('*') === -1).map(path => abspath(workingDirectory, path))
        const existingRawPathsPromise = filterExistingPaths(workingDirectory, rawPaths, errors)
        const excludes = uniqueStringArray(defaultExcludes, ignore).map(ig => !ig.startsWith('!') ? `!${ig}` : ig)
        const globMatchProms = globOnly.map(globexpr => globWithExcludes(workingDirectory, globexpr, excludes))
        const globSettleds = await Promise.allSettled(globMatchProms)
        const files: string[] = []
        for (const settledMatch of globSettleds) {
            if (settledMatch.status === 'rejected') {
                continue
            }
            const [ globexpr, paths, error ] = settledMatch.value
            if (error) {
                errors.push({file: null, e: new Error(`ERROR: unable to run glob expression '${globOnly.join(', ')}: ${error}`)});
            }
            if (paths?.length) {
                const uniqueList = uniqueStringArray(paths.map(file => abspath(workingDirectory, file)))
                files.push(...uniqueList)
            }
            if (paths?.length === 0 && emptyMatchWarningContext) {
                console.warn(colors.yellow(`WARNING; '${globexpr}' did not match any file while ${emptyMatchWarningContext}`))
            }
        }
        if (errors.length) {
            return resolve([null, errors])
        }
        if (forEachFile) {
            const proms = files.map(filename => forEachFile(filename, errors));
            await Promise.allSettled(proms)
        }
        const [ existingRawPaths ] = await existingRawPathsPromise
        if (errors.length) {
            return resolve([null, errors])
        }
        const allFiles = existingRawPaths.map(file => abspath(workingDirectory, file))
        allFiles.push(...files)
        const uniqueFullList = uniqueStringArray(allFiles)
        return resolve([uniqueFullList, errors.length ? errors : null])
    })
}

function globWithExcludes(workingDirectory: string, globexpr: string, excludes: string[]) {
    const globExprsFinal = [globexpr, ...excludes];
    return promise<[string, string[], Error]>(resolve => {
        fg(globExprsFinal, { dot: true, cwd: workingDirectory }).then(async (files: string[]) => {
            return resolve([globexpr, files, null]);
        }).catch(e => {
            return resolve([globexpr, null, e]);
        });
    })
}

async function filterExistingPaths(workingDirectory: string, paths: string[], errors: FileError[]): Promise<GlobResult> {
    const rawPathProms = paths.map(path => existingPath(workingDirectory, path));
    const settled = await Promise.allSettled(rawPathProms)
    const existingPaths: string[] = []
    for (let i = 0; i < paths.length; ++i) {
        (settled[i] as any)._path = paths[i]
    }
    let errored = false
    for (const settlement of settled) {
        const path = (settlement as any)._path
        if (settlement.status === 'fulfilled') {
            if (typeof settlement.value === 'string') {
                existingPaths.push(abspath(workingDirectory, settlement.value))
            } else {
                const e = settlement.value
                e.message = `lookUpError: for '${path}': ${e.message}`
                errored = true
                errors.push({
                    file: path,
                    e,
                })
            }
        } else if (settlement.status === 'rejected') {
            errored = true
            errors.push({
                file: path,
                e: new Error(settlement.reason),
            })
        }
    }
    if (errored) {
        return [null, errors]
    }
    return [existingPaths, null]
}

type CommandResult = [number, string, string, Error]
function runCommand(command: string, options?: ExecOptions) {
    if (!options) { options = {} }
    let exitCode = 0
    return promise<CommandResult>(resolve => {
        exec(command, options, (e, stdout, stderr) => {
            resolve([exitCode, stdout, stderr, e])
        }).on('exit', code => exitCode = code)
    })
}

function shasumFile(file: string) {
    return promise<[string, string]>(resolve => {
        const fd = fs.createReadStream(file);
        const hash = crypto.createHash('sha512')
        hash.setEncoding('binary')
        hash.update(Buffer.from(`sha512-truncated-to-32-byte; filename=${pathlib.basename(file)};`, 'ascii')) // salting
        fd.on('end', () => {
            hash.end()
            const hashBuffer: Buffer = hash.digest().subarray(0, 32)
            resolve([pathlib.relative(process.cwd(), file), hashBuffer.toString('hex')])
        })
        fd.pipe(hash)
    })
}

function shasumStringArray(context: string, arr: string[]) {
    const hash = crypto.createHash('sha512')
    hash.setEncoding('binary')
    hash.update(Buffer.from(`sha512-truncated-to-32-byte; context=${context}`, 'ascii')) // salting
    hash.update(Buffer.from(arr.join(''), 'ascii'))
    hash.end()
    return hash.digest().subarray(0, 32).toString('hex')
}

function getFileContent(file: string, errors?: FileError[]) {
    if (!errors) { errors = []; }
    return promise<{file: string, data: string}>(async (resolve) => {
        fs.readFile(file, 'utf8', (e, data) => {
            if (e) {
                errors.push({ file, e })
                return resolve({ file, data: null })
            }
            return resolve({ file, data })
        });
    });
}

function dockerCacheFromResolve(imagePath: string) {
    return promise<[boolean, string, string]>(async (resolve) => {
        const [ code, stdout, stderr, e ] = await runCommand(`docker manifest inspect --insecure '${imagePath}'`)
        resolve(code === 0 ? [true, imagePath, null] : [false, imagePath, stderr])
    });
}

function setFileContent(file: string, content: string, errors?: FileError[]) {
    if (!errors) { errors = []; }
    return promise<boolean>(async (resolve) => {
        fs.writeFile(file, content, 'utf8', e => {
            if (e) {
                errors.push({ file, e })
                return resolve(false)
            }
            return resolve(true)
        });
    });
}

function existingPath(workingDirectory: string, path: string) {
    return promise<string | Error>(resolve => {
        fs.access(abspath(workingDirectory, path), error => {
            return resolve(!error ? path : error)
        });
    })
}

function entityStat(path: string): Promise<[string, fs.Stats]> {
    return promise<[string, fs.Stats]>(resolve => {
        fs.lstat(path, (e, stats) => {
            if (e) {
                return resolve([path, null])
            }
            return resolve([path, stats])
        })
    })   
}

function abspath(workingDirectory: string, path: string) {
    if (pathlib.isAbsolute(path)) {
        return path
    }
    return pathlib.resolve(pathlib.join(workingDirectory, path))
}

function uniqueStringArray(...arrays: string[][]) {
    const newArr: string[] = []
    for (const arr of arrays) {
        newArr.push(...arr)
    }
    return [...new Set(newArr)]
}

function stringArray(input: string | string[] | null, passthruNull = false): string[] {
    if (typeof input === 'string') {
        return [input].filter(a => a.trim())
    }
    if (!input) {
        if (passthruNull) {
            return null
        }
        return []
    }
    return input
}

function getEphemeralComponentFullpath(compo: ComponentManifest, config: TypedBuilderConfig, tag?: string) {
    const tempRegistry = stringArray(config.docker?.registry?.temp)[0];
    return `${tempRegistry}/${compo.project ? compo.project + '/' : ''}${compo.docker.image_name}:${tag ?? compo.hash}`
}

function getPrecommitComponentPublishPaths(compo: ComponentManifest, config: TypedBuilderConfig) {
    const registries = stringArray(config.docker?.registry?.precommit);
    return registries.map(reg => {
        while (reg.endsWith('/')) { reg = reg.slice(0, -1) }
        return `${reg}/${compo.docker.image_name}`
    })
}

function getPostcommitComponentPublishPaths(compo: ComponentManifest, config: TypedBuilderConfig) {
    const registries = stringArray(config.docker?.registry?.postcommit);
    return registries.map(reg => {
        while (reg.endsWith('/')) { reg = reg.slice(0, -1) }
        return `${reg}/${compo.docker.image_name}`
    })
}

function findParentComponentByName(name: string, compoMap: ComponentManifestMap) {
    let parentCompo: ComponentManifest = null
    for (const compoFullName of Object.keys(compoMap)) {
        const peerCompo = compoMap[compoFullName]
        if (peerCompo.name === name || peerCompo.fullname === name) {
            parentCompo = peerCompo
            break
        }
    }
    return parentCompo
}

function notSet(v: any) {
    return v === null || v === undefined
}

function defaultTrue(v: any) {
    if (v === null || v === undefined) {
        return true
    }
    return !!v
}

function defaultFalse(v: any) {
    if (v === null || v === undefined) {
        return true
    }
    return !!v
}

function copy<T = any>(target: T) {
    if (!target) {
        return null
    }
    try {
        return JSON.parse(JSON.stringify(target)) as T
    } catch (e) {
        console.error(e)
        return null
    }
}

export async function findBuilderConfig(fromDirectory = process.cwd()) {
    const configChain: BuilderConfigChain = { chain: [], active: null }
    let path = fromDirectory
    let lookFor = ''
    let lookFor2 = ''
    while(pathlib.dirname(path) !== path) {
        lookFor = pathlib.join(path, 'builder.config.yml')
        lookFor2 = pathlib.join(path, 'builder.config.yaml')
        path = pathlib.dirname(path)
        const [ ymlResult, yamlResult ] = await Promise.allSettled([entityStat(lookFor), entityStat(lookFor2)])
        let stat: fs.Stats = null
        if (!stat) { stat = ymlResult.status === 'fulfilled' && ymlResult.value[1] ? ymlResult.value[1] : null; }
        if (!stat) { stat = yamlResult.status === 'fulfilled' && yamlResult.value[1] ? yamlResult.value[1] : null; }
        if (stat) {
            const { data } = await getFileContent(lookFor, [])
            if (!data) {
                continue
            }
            const yamlData = yaml.load(data)
            const configData: BuilderConfig = Array.isArray(yamlData) ? yamlData : [yamlData]
            configChain.chain.push({
                file: lookFor,
                config: configData,
            })
        }
    }
    return configChain
}

export function getActiveBuilderConfig(configChain: BuilderConfigChain) {
    if (configChain.active) {
        return configChain.active
    }
    const activeConfig: TypedBuilderConfig = copy(configChain.chain[0]?.config?.[0])
    configChain.active = activeConfig
    return activeConfig
}

export async function resolveBuildEnvironment(config: TypedBuilderConfig, options: BuilderCustomOptions) {
    if (!options) { options = {} }
    if (!config.base_branch) {
        config.base_branch = 'main'
    }
    if (!config.head_branch) {
        const [code, stdout, stderr, e] = await runCommand(`git rev-parse --abbrev-ref HEAD`)    
        if (!e && !stderr && code === 0 && stdout.trim()) {
            config.head_branch = stdout.trim()
        } else {
            config.head_branch = 'main'
        }
    }
    if (options.baseBranch) {
        config.base_branch = options.baseBranch
    }
    if (options.headBranch) {
        config.head_branch = options.headBranch
    }
    if (notSet(config.is_postcommit)) {
        config.is_postcommit = config.base_branch === config.head_branch
    }
    if (notSet(config.is_precommit)) {
        config.is_precommit = config.base_branch !== config.head_branch
    }
    return config
}
