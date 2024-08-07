import * as fs from 'fs'
import * as yaml from 'js-yaml'
import * as pathlib from 'path'
import * as crypto from 'crypto'
import * as readline from 'readline'
import * as os from 'os'
import { ExecOptions, SpawnOptions, exec, spawn } from 'child_process'
import { promise } from 'ts-basis'
import {
    BuilderConfig,
    BuilderConfigChain,
    ComponentBuildStatus,
    ComponentManifest,
    ComponentManifestMap,
    OtherNamedPublishMap,
    TypedBuilderConfig,
    componentStatusFlowStop,
    componentStatusPending,
} from './model'
import { v4 as uuidv4 } from 'uuid'
const fg = require('fast-glob')
const colors = require('colors/safe')

const defaultExcludes = [
    '.DS_Store',
    'node_modules',
    'generated-sources',
    '*.log',
]
type FileError = { file: any; e: Error; data?: any; isWarning?: boolean }
type GlobResult<T = string[]> = [T, FileError[]]
const currentBuilds: { [componentFullName: string]: boolean } = {}

let currentOutputOwner = ''
const rectifyOutputSection = (
    compoFullName: string,
    options: BuilderCustomOptions,
) => {
    if (currentOutputOwner !== compoFullName) {
        currentOutputOwner = compoFullName
        let procHeaderBase = `--------- ${compoFullName} ----------------------`
        if (procHeaderBase.length < 80) {
            procHeaderBase += '-'.repeat(80 - procHeaderBase.length)
        }
        const procHeader = `${colors.gray(procHeaderBase)}`
        options.log('')
        options.log(procHeader)
    }
}

export type BuilderCustomOptions = {
    tag?: string
    ci?: boolean
    precommitContext?: string
    workingDirectory?: string
    baseBranch?: string
    headBranch?: string
    prebuilt?: boolean
    cache?: boolean
    pull?: boolean
    background?: boolean
    wait?: boolean

    logStream?: fs.WriteStream
    log?: (line: string) => any
    error?: (line: string) => any
    warn?: (line: string) => any

    onFinish?: (v: boolean) => any
}

export async function killLogTail(logFile: string) {
    const [code, stdout, stderr, e] = await runCommand(`ps -ef`)
    const entries = stdout
        .split('\n')
        .map(a => a.trim())
        .filter(a => a)
    const matchedPids = entries
        .filter(a => a.indexOf(`tail -f -n +1 ${logFile}`) >= 0)
        .map(psLine => psLine.split(' ').filter(a => a)[1])
    if (matchedPids.length) {
        await Promise.all(matchedPids.map(pid => runCommand(`kill -9 ${pid}`)))
    }
}

export async function nohupDisown(args: string[]) {
    await runCommand(
        `nohup ${args.map(a => `'${a}'`).join(' ')} >/dev/null 2>&1 &disown`,
    )
}

export async function buildAllGroups(
    options: BuilderCustomOptions,
    compoMap: ComponentManifestMap,
    buildGroups: ComponentManifest[][],
    configChain?: BuilderConfigChain,
) {
    if (!configChain) {
        configChain = await findBuilderConfig()
    }
    setFileContent(`build.all.map.log`, JSON.stringify(buildGroups, null, 4))
    const startTime = Date.now()
    const config = getActiveBuilderConfig(configChain)
    const buildEnv = config.is_postcommit ? 'POST_COMMIT' : 'PRE_COMMIT'
    const allErrors: FileError[] = []
    const end = () => {
        setFileContent(
            `build.all.map.log`,
            JSON.stringify(buildGroups, null, 4),
        )
        const dur = ((Date.now() - startTime) / 1000).toFixed(1)
        options.log(`Finished in ${colors.yellow(dur + 's')}`)
        if (allErrors.length) {
            options.log(`Overall result: ${colors.red('FAILED')}\n`)
        } else {
            options.log(`Overall result: ${colors.green('SUCCESS')}\n`)
        }
        return allErrors.length ? allErrors : null
    }
    options.log('')
    options.log(colors.gray(`INVOKE_ENV: ${colors.cyan(buildEnv)}`))
    options.log(colors.gray(`HEAD_BRANCH: ${colors.cyan(config.head_branch)}`))
    options.log(colors.gray(`BASE_BRANCH: ${colors.cyan(config.base_branch)}`))
    options.log('')
    options.log(
        colors.gray(`Building components in the following group order:`),
    )
    let groupIndex = 0
    for (const buildGroup of buildGroups) {
        ++groupIndex
        options.log(colors.green(`[${'group-' + groupIndex}]`))
        for (const compo of buildGroup) {
            const name = `${compo.name}${compo.project ? ` (${compo.project})` : ''}`
            options.log(
                `    ${colors.yellow(name)} ${colors.gray('@' + compo.hash.slice(1))}`,
            )
        }
    }
    options.log('')
    for (const buildGroup of buildGroups) {
        const groupPrepProcesses = buildGroup.map(compoManifest =>
            buildPrepComponent(
                options,
                compoMap,
                compoManifest,
                configChain,
                allErrors,
            ),
        )
        await Promise.allSettled(groupPrepProcesses)
        if (allErrors.length) {
            return end()
        }
    }
    const elapsed = () => {
        const dur = Math.floor((Date.now() - startTime) / 1000)
        const date = new Date(null)
        date.setSeconds(dur)
        return `[${date.toISOString().slice(11, 19)}]`
    }
    const ongoingBuildsAnnounceInterval = 15000
    const ongoingBuildsAnnouncer = setInterval(() => {
        rectifyOutputSection('[ BUILD CONTROLLER ]', options)
        options.log(
            `${elapsed()} in progress ...  ${Object.keys(currentBuilds).join(' ')}`,
        )
    }, ongoingBuildsAnnounceInterval)
    const firstGroup = buildGroups[0]
    if (firstGroup) {
        await Promise.allSettled(
            firstGroup.map(compo => {
                return tryBuildComponentAndDownstream(
                    options,
                    compoMap,
                    compo,
                    configChain,
                    allErrors,
                )
            }),
        )
    }
    options.log('')
    clearInterval(ongoingBuildsAnnouncer)
    return end()
}

async function tryBuildComponentAndDownstream(
    options: BuilderCustomOptions,
    compoMap: ComponentManifestMap,
    compo: ComponentManifest,
    configChain: BuilderConfigChain,
    errors?: FileError[],
) {
    if (!componentStatusPending(compo.status)) {
        return
    }
    const dependencies = compo.depends_on ?? []
    const upstreamAllDone =
        dependencies.filter(upstreamCompoName =>
            componentStatusPending(compoMap[upstreamCompoName].status),
        ).length === 0
    if (!upstreamAllDone) {
        return
    }
    const upstreamStatuses = dependencies.map(
        upstreamCompoName => compoMap[upstreamCompoName].status,
    )
    const downstreamContinue =
        upstreamStatuses.filter(status => componentStatusFlowStop(status))
            .length === 0
    if (!downstreamContinue) {
        return
    }
    currentBuilds[compo.fullname] = true
    compo.status = 'building'
    await buildComponent(options, compoMap, compo, configChain, errors)
    delete currentBuilds[compo.fullname]
    const downstreams = compo.depended_on_by ?? []
    await Promise.allSettled(
        downstreams.map(downstreamCompoName => {
            const downstreamCompo = compoMap[downstreamCompoName]
            return tryBuildComponentAndDownstream(
                options,
                compoMap,
                downstreamCompo,
                configChain,
                errors,
            )
        }),
    )
    if (Object.keys(currentBuilds).length === 0) {
        options.onFinish?.(errors.length === 0)
    }
}

function buildComponent(
    options: BuilderCustomOptions,
    compoMap: ComponentManifestMap,
    compo: ComponentManifest,
    configChain: BuilderConfigChain,
    errors?: FileError[],
) {
    if (!errors) {
        errors = []
    }
    const config = getActiveBuilderConfig(configChain)
    if (compo.builder === 'docker') {
        return promise<ComponentBuildStatus>(async resolve => {
            if (compo._process.build_lock) {
                // you build component only once
                resolve(compo.status)
                return
            }
            compo._process.build_lock = uuidv4()
            const startTime = Date.now()
            const streamFile = `build.${compo.name_safe}.log`
            const publishedLogFile = `build.all.published.log`
            const logFile = fs.createWriteStream(streamFile, { flags: 'a+' })
            let resolved = false
            const tryResolve = (status: ComponentBuildStatus) => {
                if (resolved) {
                    return
                }
                resolved = true
                try {
                    compo.status = status
                    if (status === 'success') {
                        logFile.write(`\nSUCCESS\n`)
                    } else if (status === 'failure') {
                        logFile.write(`\nFAILURE\n`)
                    } else if (status === 'canceled') {
                        logFile.write(`\nCANCELED\n`)
                    } else if (status === 'redundant') {
                    } else {
                    }
                } catch (e) {
                    console.error(e)
                }
                resolve(status)
            }

            const cliArgs: string[] = []
            if (compo.docker.debug) {
                cliArgs.push('-D')
            }
            cliArgs.push(
                'buildx',
                'build',
                '--progress=plain',
            )
            const pullFresh = (options.pull === undefined || options.pull)
            if (pullFresh && !compo.docker?.no_pull && cliArgs.indexOf('--pull') === -1) {
                cliArgs.push('--pull')
            }
            if (!options.cache || compo.no_cache) {
                cliArgs.push('--no-cache')
            }

            const outputOpts = compo.docker?.output ?? {}
            if (!outputOpts.type || outputOpts.type === 'image' || outputOpts.type === 'registry') {
                const compLevel = outputOpts.compression_level ?? 3
                const compExpr =
                    !compLevel || outputOpts.compression === 'uncompressed'
                        ? 'compression=uncompressed'
                        : `compression=${outputOpts.compression ?? 'zstd'},compression-level=${compLevel}`
                const forceComprExpr = outputOpts.force_compression
                    ? 'force-compression=true'
                    : ''
                const pushInsecureRegistry = outputOpts.allow_insecure_registry
                    ? 'registry.insecure=true'
                    : ''
                const ociMediatypes = outputOpts.oci_mediatypes
                    ? 'oci-mediatypes=true'
                    : ''
                const outputArgs = [
                    `type=${outputOpts.type ?? 'image'}`,
                    'push=true',
                    compExpr,
                    forceComprExpr,
                    pushInsecureRegistry,
                    ociMediatypes,
                ].filter(a => a).join(',')
                cliArgs.push('--output', outputArgs)
            }

            const dockerfile = compo.docker?.dockerfile ?? 'Dockerfile'
            const dockerfileAbspath = pathlib.join(compo.dir, dockerfile)
            cliArgs.push('--file', dockerfileAbspath)

            if (compo.docker.target) {
                cliArgs.push('--target', compo.docker.target)
            }

            const chosenBuilder = await chooseBuilder(config)
            if (chosenBuilder) {
                cliArgs.push('--builder', chosenBuilder)
            }

            const { allFullImagePaths, targetErrors } = getPublishTargets(
                compo,
                config,
                options,
            )

            allFullImagePaths.forEach(tag => cliArgs.push('--tag', tag))

            if (targetErrors.length) {
                const targetFileErrors: FileError[] = targetErrors.map(err => ({
                    file: dockerfileAbspath,
                    e: err,
                }))
                errors.push(...targetFileErrors)
                options.error(targetFileErrors[0].e + '')
                return tryResolve('failure')
            }

            const pushedPaths = allFullImagePaths
                .map(img => `    ${colors.green(img)}`)
                .join('\n')
            const announcePushes = () => {
                compo._process.outputs.docker_images = copy(allFullImagePaths)
                appendFileContent(
                    publishedLogFile,
                    allFullImagePaths.join('\n') + '\n',
                )
                rectifyOutputSection(compo.fullname, options)
                options.log(
                    `Successfully published ${colors.cyan(compo.fullname)} to:\n${pushedPaths}\n`,
                )
            }

            // Check prebuilt
            if (compo._process?.prebuilt_status === 'handled') {
                rectifyOutputSection(compo.fullname, options)
                const skipMessage =
                    `${colors.yellow(`[PREBUILT]`)} ` +
                    `${colors.cyan(compo.fullname)}${colors.gray('@' + compo.hash.slice(1))}` +
                    ` has been published before, skipping building.`
                options.log(skipMessage)
                announcePushes()
                const retaggedTargets = `Retagged targets: \n${allFullImagePaths.map(a => `    ${a}`).join('\n')}`
                logFile.write(
                    `${skipMessage}\n${retaggedTargets}\nSKIPPED\n(REDUNDANT; PREBUILT EXISTS)\n\n`,
                )
                return tryResolve('redundant')
            }

            const buildArgsFinal: { [argname: string]: string } = {}
            const buildArgsInfoFinal: {
                [secretname: string]: { expr: string; value: string }
            } = {}
            const addBuildArgs = () => {
                const buildArgsCommon =
                    copy(compo.docker?.build_args_inherited, options) ?? {}
                const buildArgsTemp =
                    copy(compo.docker?.build_args_temp, options) ?? {}
                const buildArgsOverride =
                    copy(compo.docker?.build_args, options) ?? {}
                Object.assign(buildArgsFinal, buildArgsCommon)
                Object.assign(buildArgsFinal, buildArgsTemp)
                Object.assign(buildArgsFinal, buildArgsOverride)
                uniqueStringArray(Object.keys(buildArgsFinal)).forEach(
                    argname => {
                        const argExpr = `${buildArgsFinal[argname]}`
                        const buildArgWithEnvSubst = envSubst(argExpr)
                        buildArgsInfoFinal[argname] = {
                            expr: argExpr,
                            value: buildArgWithEnvSubst,
                        }
                        const finalExpr = `${argname}=${buildArgWithEnvSubst}`
                        cliArgs.push('--build-arg', finalExpr)
                    },
                )
            }
            addBuildArgs()

            const buildSecretsFinal: {
                [secretname: string]: { expr: string; value: string }
            } = {}
            const addSecrets = () => {
                if (
                    !compo.docker.secret ||
                    !Object.keys(compo.docker.secret).length
                ) {
                    return
                }
                const secretIds = Object.keys(compo.docker.secret)
                secretIds.forEach(id => {
                    const secretExpr = compo.docker.secret[id]
                    const secretValue = envSubst(secretExpr)
                    const secretAbsPath = pathlib.join(compo.dir, secretValue)
                    cliArgs.push('--secret', `id=${id},src=${secretAbsPath}`)
                    buildSecretsFinal[id] = {
                        expr: secretExpr,
                        value: secretValue,
                    }
                })
            }
            addSecrets()

            const addCacheOpts = async () => {
                if (!stringArray(config.docker?.registry?.cache).length) {
                    return
                }
                const cacheConf = compo.docker?.cache_config ?? {}
                const mode = cacheConf.mode ?? 'max'
                const compLevel =
                    compo.docker?.cache_config?.compression_level ?? 3
                const compExpr =
                    !compLevel || cacheConf.compression === 'uncompressed'
                        ? 'compression=uncompressed'
                        : `compression=${cacheConf.compression ?? 'zstd'},compression-level=${compLevel}`
                const forceComprExpr = cacheConf.force_compression
                    ? 'force-compression=true'
                    : ''
                const defaultCacheToOpts = [
                    `mode=${mode}`,
                    `ignore-error=true`,
                    compExpr,
                    forceComprExpr,
                    `image-manifest=true`,
                ]
                    .filter(a => a)
                    .join(',')
                const cacheRegistries = stringArray(
                    config.docker?.registry?.cache,
                )
                const cacheFromResolves: Promise<[boolean, string, string]>[] =
                    []
                for (const cacheRegistry of cacheRegistries) {
                    const imagePath =
                        `${cacheRegistry}/${compo.fullname}`.toLowerCase()
                    const imageRefBase =
                        `${imagePath}:${config.base_branch.replace(/\//g, '__')}`.toLowerCase()
                    const imageRefHead =
                        `${imagePath}:${config.head_branch.replace(/\//g, '__')}`.toLowerCase()
                    cacheFromResolves.push(dockerCacheFromResolve(imageRefBase))
                    cacheFromResolves.push(dockerCacheFromResolve(imageRefHead))
                    if (imageRefHead !== imageRefBase || config.is_postcommit) {
                        cliArgs.push(
                            '--cache-to',
                            `type=registry,ref=${imageRefHead},${defaultCacheToOpts}`.toLowerCase(),
                        )
                    }
                }
                const cacheLookUpSettleds =
                    await Promise.allSettled(cacheFromResolves)
                for (const cacheLookUpSettled of cacheLookUpSettleds) {
                    if (cacheLookUpSettled.status === 'rejected') {
                        continue
                    }
                    const [imageExists, imagePath, stderr] =
                        cacheLookUpSettled.value
                    if (!imageExists) {
                        rectifyOutputSection(compo.fullname, options)
                        options.log(
                            colors.gray(
                                `[CACHE_MISS] cache image not found: ${stderr.trim().split('\n')[0]}`,
                            ),
                        )
                        continue
                    }
                    cliArgs.push(
                        '--cache-from',
                        `type=registry,ref=${imagePath}`,
                    )
                }
            }
            await addCacheOpts()

            const contextDir = compo.docker.context
                ? pathlib.join(compo.dir, compo.docker.context)
                : compo.dir
            cliArgs.push(contextDir)

            logFile.write(
                `docker buildx build ` +
                    `${cliArgs
                        .slice(2)
                        .map(a => (a.startsWith('--') ? a : `${a}\n    `))
                        .join(' ')}` +
                    `\n\n`,
            )

            const spawnOpts: SpawnOptions = {}
            const proc = spawn('docker', cliArgs, spawnOpts)

            let inErrorSection = false
            const elapsed = () => {
                const dur = Math.floor((Date.now() - startTime) / 1000)
                const date = new Date(null)
                date.setSeconds(dur)
                return `[${date.toISOString().slice(11, 19)} ${compo.fullname}]`
            }
            const isStepsLine = (lit: string[]) => {
                return (
                    (lit[1] &&
                        lit[1].charAt(0) === '[' &&
                        parseInt(lit[1].charAt(1)) >= 0) ||
                    (lit[2] &&
                        lit[2].endsWith(']') &&
                        parseInt(lit[2].replace(/\//g, '')) >= 0)
                )
            }
            const isErrorLine = (lit: string[]) =>
                lit[0] === 'ERROR:' || lit[1] === 'ERROR:'
            const isAppErrorLine = (line: string) => {
                const pos = line.toLowerCase().indexOf('error:')
                return pos >= 0 && pos < 10
            }
            const shouldIgnore = (line: string) =>
                line.indexOf(' registry cache ') >= 0
            const echoLine = (line: string, isError = false) => {
                rectifyOutputSection(compo.fullname, options)
                if (isError) {
                    options.log(colors.red(`${elapsed()}      ${line}    `))
                } else {
                    options.log(`${elapsed()}      ${line}`)
                }
            }
            const handleLine = line => {
                const lit = line.split(' ').filter(a => a)
                const cacheExportClauseAt = line
                    .slice(0, 40)
                    .indexOf('exporting cache to registry')
                if (cacheExportClauseAt >= 0 && cacheExportClauseAt < 10) {
                    finishProc()
                    return
                }
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
            let alreadyFinished = false
            const finishProc = (code = 0) => {
                if (alreadyFinished) {
                    return
                }
                alreadyFinished = true
                const isSuccessful = code === 0
                const dur = ((Date.now() - startTime) / 1000).toFixed(1)
                echoLine(
                    isSuccessful
                        ? `${colors.green('FINISHED')} '${compo.fullname}' (${dur}s)`
                        : `${colors.red('FAILED')} '${compo.fullname}' (${dur}s), exitcode=${code}`,
                )
                if (!isSuccessful) {
                    errors.push({
                        file: dockerfileAbspath,
                        e: new Error(
                            `ERROR; docker build failed for component '${compo.name}'` +
                                `\n(more info at ${streamFile}:1:1):\n`,
                        ),
                    })
                } else {
                    announcePushes()
                }
                if (resolved) {
                    logFile.write(isSuccessful ? `\nSUCCESS\n` : `\nFAILURE\n`)
                    return
                } else {
                    tryResolve(isSuccessful ? 'success' : 'failure')
                }
            }

            echoLine(`${colors.green('STARTED')} '${compo.fullname}'`)

            for (const argName of Object.keys(buildArgsInfoFinal)) {
                const argInfo = buildArgsInfoFinal[argName]
                const argExtra =
                    argInfo.expr !== argInfo.value
                        ? ` ## (evaluated: '${argInfo.value}')`
                        : ''
                echoLine(
                    `    ARG ${colors.cyan(argName)}='${argInfo.expr}'${argExtra}`,
                )
            }

            for (const secretName of Object.keys(buildSecretsFinal)) {
                const secretInfo = buildSecretsFinal[secretName]
                const secretExtra =
                    secretInfo.expr !== secretInfo.value
                        ? ` ## (evaluated: '${secretInfo.value}')`
                        : ''
                echoLine(
                    `    SECRET ${colors.cyan(secretName)}='${secretInfo.expr}'${secretExtra}`,
                )
            }

            const stdoutReader = readline
                .createInterface({
                    input: proc.stdout,
                    terminal: false,
                })
                .on('line', line => {
                    logFile.write(line)
                    logFile.write('\n')
                    handleLine(line)
                })

            const stderrReader = readline
                .createInterface({
                    input: proc.stderr,
                    terminal: false,
                })
                .on('line', line => {
                    logFile.write(line)
                    logFile.write('\n')
                    handleLine(line)
                })

            proc.on('close', code => {
                stdoutReader.close()
                stderrReader.close()
                finishProc(code)
            })
        })
    } else {
        return promise<boolean>(resolve => {
            compo.status = 'success'
            resolve(true)
        })
    }
}

async function buildPrepComponent(
    options: BuilderCustomOptions,
    compoMap: ComponentManifestMap,
    compo: ComponentManifest,
    configChain: BuilderConfigChain,
    errors: FileError[],
) {
    if (!errors) {
        errors = []
    }
    const config = getActiveBuilderConfig(configChain)
    if (!compo._process) {
        compo._process = {}
    }
    if (!compo._process.outputs) {
        compo._process.outputs = {}
    }
    if (compo.builder === 'docker') {
        const dockerfile = compo.docker?.dockerfile ?? 'Dockerfile'
        const dockerfileAbspath = pathlib.join(compo.dir, dockerfile)
        const { data } = await getFileContent(dockerfileAbspath, [])
        if (!data) {
            errors.push({
                file: dockerfileAbspath,
                e: new Error(
                    `ERROR; Unable to find docker file at '${dockerfile}'`,
                ),
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
            compo.docker.build_args_inherited = copy(
                config.docker?.build_args,
                options,
            )
        }
        const linesWithExtendFrom: string[] = []
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
                        e: new Error(
                            `ERROR; Dockerfile 'ARG EXTEND_FROM' usage cannot exist after the first FROM directive` +
                                ` (near '${line}' at ${dockerfileAbspath}:${lineNumber})`,
                        ),
                    })
                }
            }
        }
        const formatName = (name: string) =>
            name.toLowerCase().replace(/__/g, '/')
        const allCompoRegularNames = Object.keys(compoMap).map(fullname => ({
            name: formatName(compoMap[fullname].name),
            compo: compoMap[fullname],
        }))
        const allCompoFullNames = Object.keys(compoMap).map(fullname => ({
            name: formatName(compoMap[fullname].fullname),
            compo: compoMap[fullname],
        }))
        const allCompoNames = [...allCompoRegularNames, ...allCompoFullNames]
        const depNames = linesWithExtendFrom.map(
            line =>
                line
                    .replace('ARG EXTEND_FROM_', '')
                    .split('=')[0]
                    .split(' ')[0],
        )
        for (const depName of depNames) {
            const depNameOriginal = depName.toLowerCase().replace(/__/g, '/')
            const depNameHyphen = depNameOriginal.replace(/_/g, '-')
            const found = allCompoNames.filter(
                a => a.name === depNameOriginal || a.name === depNameHyphen,
            )
            if (found.length === 0) {
                errors.push({
                    file: dockerfileAbspath,
                    e: new Error(
                        `ERROR; component dockerfile is using 'EXTEND_FROM_${depName}' ` +
                            `but the parent component '${depNameOriginal}' is missing from dependency declaration in ` +
                            `'depends_on' in the component manifest '${compo.manifest_path}'`,
                    ),
                })
                continue
            }
            const parentCompo = found.map(a => a.compo)[0]
            if (!parentCompo) {
                errors.push({
                    file: dockerfileAbspath,
                    e: new Error(
                        `ERROR; component dockerfile is using 'EXTEND_FROM_${depName}' ` +
                            `but the parent component '${parentCompo.name}' not found on the component map ` +
                            `while parsing '${compo.manifest_path}'`,
                    ),
                })
                continue
            }
            if (!compo.docker.build_args_temp) {
                compo.docker.build_args_temp = {}
            }
            compo.docker.build_args_temp[`EXTEND_FROM_${depName}`] =
                getEphemeralComponentFullpath(parentCompo, config)
        }
        if (errors.length) {
            return
        }
    } else {
        errors.push({
            file: compo.manifest_path,
            e: new Error(
                `ERROR; 'builder' not specified in build manifest '${compo.manifest_path}'`,
            ),
        })
        return
    }
    // check prebuilts
    if (options.prebuilt && !compo.no_prebuilt) {
        const { allFullImagePaths } = getPublishTargets(compo, config, options)
        const hasPrebuilts = await handlePrebuilts(
            allFullImagePaths,
            compo,
            config,
            options,
        )
        if (hasPrebuilts) {
            compo._process.prebuilt_status = 'handled'
        } else {
            compo._process.prebuilt_status = 'cache-miss'
        }
    }
    // reattach at the end
    const _process = compo._process
    delete compo._process
    compo._process = _process
}

export async function getComponentsMap(
    options: BuilderCustomOptions,
): Promise<GlobResult<ComponentManifestMap>> {
    const map: ComponentManifestMap = {}
    const errors: FileError[] = []
    options.log(
        colors.gray(
            `\ntrying to find buildable components in '${process.cwd()}' ...`,
        ),
    )
    const manifestPatterns = [
        `./**/*.component.yml`,
        `./**/*.component.yaml`,
        `./**/component.*.yml`,
        `./**/component.*.yaml`,
        `./**/*.build.yml`,
        `./**/*.build.yaml`,
        `./**/*.test.yml`,
        `./**/*.test.yaml`,
    ]
    await getGlobMatched(
        options,
        options.workingDirectory ?? './',
        manifestPatterns,
        defaultExcludes,
        errors,
        async file => {
            try {
                const { data } = await getFileContent(file, errors)
                const compo = yaml.load(data) as ComponentManifest
                compo.manifest_path = file
                compo.dir = pathlib.dirname(file)
                if (!compo.name) {
                    errors.push({
                        file,
                        e: new Error(
                            `ERROR: component name not found\n    ${file}`,
                        ),
                    })
                    return
                }
                if (
                    compo.name.indexOf('-') >= 0 &&
                    compo.name.indexOf('_') >= 0
                ) {
                    errors.push({
                        file,
                        e: new Error(
                            `ERROR: component name cannot have both hyphen '-' and underscore '_'\n    ${file}`,
                        ),
                    })
                    return
                }
                compo.name_hyphen = compo.name.replace(/_/g, '-')
                if (!compo.project) {
                    compo.project = ''
                }
                compo.fullname = compo.project
                    ? `${compo.project}/${compo.name_hyphen}`
                    : compo.name_hyphen
                compo.name_safe = compo.fullname
                    .replace(/\//g, '__')
                    .toLowerCase()
                if (map[compo.fullname]) {
                    if (file !== map[compo.fullname].manifest_path) {
                        errors.push({
                            file,
                            e: new Error(
                                `ERROR: component name '${compo.fullname}' exists already\n    at ${file} ` +
                                    `(registered by ${map[compo.fullname].manifest_path})`,
                            ),
                        })
                    }
                    return
                }
                map[compo.fullname] = compo
                if (notSet(compo.timeout)) {
                    compo.timeout = 1800
                }
                const manigestRelpath = pathlib.relative(
                    process.cwd(),
                    compo.manifest_path,
                )
                options.log(
                    colors.gray(
                        `    found component ${colors.green(compo.name)} (${manigestRelpath})`,
                    ),
                )
                if (compo.depends_on) {
                    compo.depends_on = stringArray(compo.depends_on)
                }
                if (!compo._circular_dep_checker) {
                    compo._circular_dep_checker = []
                }
            } catch (e) {
                errors.push({
                    file,
                    e: new Error(
                        `ERROR: unable to yaml parse\n    ${file}: ${e}`,
                    ),
                })
                return
            }
        },
    )
    if (errors.length) {
        return [null, errors]
    }
    return [map, null]
}

export function getDependencyErrors(map: ComponentManifestMap) {
    const errors: FileError[] = []
    for (const fullname of Object.keys(map)) {
        const compo = map[fullname]
        if (!compo.depends_on) {
            continue
        }
        for (let i = 0; i < compo.depends_on.length; ++i) {
            const depname = compo.depends_on[i]
            const depfullname =
                depname.indexOf('/') === -1
                    ? `${compo.project ? compo.project + '/' : ''}${depname}`
                    : depname
            if (depname !== depfullname) {
                compo.depends_on[i] = depfullname
            }
            const dep = map[depfullname]
            if (!dep) {
                errors.push({
                    file: compo.manifest_path,
                    e: new Error(
                        `ERROR: dependency '${depfullname}' not found\n    at ${compo.manifest_path}`,
                    ),
                })
                continue
            }
            if (!dep.depended_on_by) {
                dep.depended_on_by = []
            }
            if (dep.depended_on_by.indexOf(compo.fullname) === -1) {
                dep.depended_on_by.push(compo.fullname)
            }
            compo._circular_dep_checker.push(dep)
        }
    }
    try {
        JSON.stringify(map)
        return errors.length ? errors : null
    } catch (e) {
        errors.push({
            file: null,
            e: new Error(
                `ERROR: components manifest with a circular dependency`,
            ),
            data: map,
        })
        return errors
    }
}

export function orderBuildsInGroups(mapArg: ComponentManifestMap) {
    const totalList: ComponentManifest[][] = []
    const map = { ...mapArg } // clone
    const alreadyBuilt: { [fullname: string]: ComponentManifest } = {}
    // extract root level dependencies
    let buildGroup = 0
    for (const fullname of Object.keys(map)) {
        const compo = map[fullname]
        if (!compo.depends_on || compo.depends_on.length === 0) {
            if (!totalList[0]) {
                totalList.push([])
            }
            totalList[0].push(compo)
            alreadyBuilt[fullname] = compo
            delete map[fullname]
        }
    }
    while (Object.keys(map).length > 0) {
        totalList.push([])
        buildGroup++
        const toBeBuiltInThisGroup: string[] = []
        for (const fullname of Object.keys(map)) {
            const compo = map[fullname]
            let allDepsReady = true
            for (const dep of compo._circular_dep_checker) {
                if (!alreadyBuilt[dep.fullname]) {
                    allDepsReady = false
                    break
                }
            }
            if (!allDepsReady) {
                continue
            }
            toBeBuiltInThisGroup.push(fullname)
        }
        for (const fullname of toBeBuiltInThisGroup) {
            const compo = map[fullname]
            totalList[buildGroup].push(compo)
            alreadyBuilt[fullname] = compo
            delete map[fullname]
        }
        if (!toBeBuiltInThisGroup.length) {
        }
    }
    for (const fullname of Object.keys(alreadyBuilt)) {
        const compo = alreadyBuilt[fullname]
        if (compo._circular_dep_checker) {
            delete compo._circular_dep_checker
        }
    }
    return totalList
}

export async function calculateComponentHashes(
    options: BuilderCustomOptions,
    compoMap: ComponentManifestMap,
    buildGroups: ComponentManifest[][],
) {
    const components: {
        filteredSources: GlobResult
        manifest: ComponentManifest
    }[] = []
    const allErrors: FileError[] = []
    buildGroups.forEach(buildGroup =>
        buildGroup.forEach(compo => {
            compo.src = stringArray(compo.src)
            components.push({
                filteredSources: null,
                manifest: compo,
            })
        }),
    )
    const prebuildScriptCount = components.filter(
        compo => compo.manifest.prebuild_script,
    ).length
    if (prebuildScriptCount) {
        const prebuildScriptRunPromise: Promise<CommandResult>[] = []
        const prebuildScriptMetadata: {
            script: string
            compo: ComponentManifest
        }[] = []
        const startTime = Date.now()
        options.log(
            '\n' +
                colors.green('[prebuild_script]') +
                ` total ${colors.yellow(prebuildScriptCount)} found, running ...`,
        )
        for (const compoData of components) {
            const compo = compoData.manifest
            if (compo.prebuild_script) {
                const scriptProc = runCommand(compo.prebuild_script, {
                    cwd: compo.dir,
                })
                prebuildScriptMetadata.push({
                    script: compo.prebuild_script,
                    compo,
                })
                options.log(
                    `${colors.gray(`${colors.yellow(compo.fullname)}:`)} ${colors.cyan(compo.prebuild_script)}`,
                )
                prebuildScriptRunPromise.push(scriptProc)
            }
        }
        const prebuildSettled = await Promise.allSettled(
            prebuildScriptRunPromise,
        )
        const prebuildDuration = ((Date.now() - startTime) / 1000).toFixed(1)
        options.log(
            colors.green('[prebuild_script]') +
                ` taken ${colors.yellow(prebuildDuration + 's')}`,
        )
        options.log('')
        for (let i = 0; i < prebuildSettled.length; ++i) {
            const settled = prebuildSettled[i]
            const scriptMetadata = prebuildScriptMetadata[i]
            if (settled.status === 'rejected') {
                allErrors.push({
                    file: scriptMetadata.compo.manifest_path,
                    e: new Error(
                        `ERROR; unhandled rejection while running command '${scriptMetadata.script}'` +
                            ` during prebuild script of '${scriptMetadata.compo.fullname}': ${settled.reason}`,
                    ),
                })
                continue
            }
            const [code, stdout, stderr, e] = settled.value
            const logFile = `build.pre.${scriptMetadata.compo.name_safe}.log`
            setFileContent(
                logFile,
                [
                    `COMMAND: ${scriptMetadata.script}`,
                    `ERROR_OBJECT: ${e ?? ''}`,
                    `========================= stdout ==============================`,
                    stdout,
                    '',
                    '',
                    '',
                    '',
                    `========================= stderr ==============================`,
                    stderr,
                    '',
                    '',
                    '',
                    '',
                ].join('\n'),
            )
            if (code !== 0) {
                allErrors.push({
                    file: scriptMetadata.compo.manifest_path,
                    e: new Error(
                        `ERROR; unhandled rejection while running command '${scriptMetadata.script}'` +
                            ` during prebuild script of '${scriptMetadata.compo.fullname}' ` +
                            `\n(more info at ${logFile}:1:1):\n${e?.message ?? ''}`,
                    ),
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
        const filteredResult = await getGlobMatched(
            options,
            compo.dir,
            compo.src as string[],
            compo.ignore,
            [],
            null,
            emptyMatchWarningContext,
        )
        compoData.filteredSources = filteredResult
        const [_, errors] = filteredResult
        if (errors) {
            for (const error of errors) {
                error.e.message =
                    `ERROR; error detected in the build manifest ` +
                    `of component '${compo.name}': one of listed sources (${stringArray(compo.src).join(', ')}) ` +
                    `cannot be found, at (${compo.dir}/${pathlib.basename(compo.manifest_path)})`
                allErrors.push(error)
            }
        }
    }
    if (allErrors.length) {
        return allErrors
    }
    for (const compoData of components) {
        const compo = compoData.manifest
        const [validPaths] = compoData.filteredSources
        validPaths.push(compo.manifest_path)
        if (compo.builder === 'docker') {
            // if builder is docker, the component dockerfile is also a default dependency
            const dockerfile = compo.docker?.dockerfile ?? 'Dockerfile'
            const dockerfileAbspath = pathlib.join(compo.dir, dockerfile)
            validPaths.push(dockerfileAbspath)
        }
        const calcContext = `for '${compo.name}' at ${compo.manifest_path}`
        const fileShasumData = await calculatePathHashes(
            validPaths,
            compo.ignore,
            compo.dir,
            options,
            allErrors,
            calcContext,
        )
        const dependsOnShasums: string[] = []
        compo.depends_on?.forEach(parentComponentName => {
            const parentCompo: ComponentManifest = findParentComponentByName(
                parentComponentName,
                compoMap,
            )
            dependsOnShasums.push(
                `dependency; ${parentCompo.fullname} @${parentCompo.hash_long}`,
            )
        })
        const componentVariantShasums: string[] = []
        if (
            compo.docker?.build_args &&
            Object.keys(compo.docker?.build_args).length
        ) {
            const predefinedArgsSkip = [
                'HTTP_PROXY',
                'HTTPS_PROXY',
                'FTP_PROXY',
                'NO_PROXY',
                'ALL_PROXY',
            ]
            const buildArgNames = Object.keys(compo.docker?.build_args).sort(
                (a, b) => a.localeCompare(b),
            )
            buildArgNames.forEach(buildArgName => {
                if (
                    predefinedArgsSkip.indexOf(buildArgName.toUpperCase()) >= 0
                ) {
                    return
                }
                const argExpr = compo.docker?.build_args[buildArgName] ?? ''
                const argValue = envSubst(argExpr)
                const valurOrExpr =
                    argValue === argExpr
                        ? argExpr
                        : `${argExpr} ## evaluated: '${argValue}'`
                componentVariantShasums.push(
                    `arg; docker --build-arg ${buildArgName}=${valurOrExpr}`,
                )
            })
        }
        if (compo.docker?.secret && Object.keys(compo.docker?.secret).length) {
            const secretNames = Object.keys(compo.docker?.secret).sort((a, b) =>
                a.localeCompare(b),
            )
            secretNames.forEach(secretName => {
                const secretExpr = compo.docker?.secret[secretName] ?? ''
                const secretValue = envSubst(secretExpr)
                const valurOrExpr =
                    secretValue === secretExpr
                        ? secretExpr
                        : `${secretExpr} ## evaluated: '${secretValue}'`
                componentVariantShasums.push(
                    `secret; docker --secret ${secretName}=${valurOrExpr}`,
                )
            })
        }
        const affectedBy = [
            ...dependsOnShasums,
            ...componentVariantShasums,
            ...fileShasumData.map(data => `file; ${data.file} @${data.hash}`),
        ]
        const totalSha = shasumStringArray(compo.fullname, [
            ...dependsOnShasums,
            ...componentVariantShasums,
            ...fileShasumData.map(data => data.hash),
        ])
        compo.affected_by = affectedBy
        compo.hash_long = totalSha
        compo.hash = `_${totalSha.slice(0, 24)}`
    }
    if (allErrors.length) {
        return allErrors
    }
    return null
}

export async function calculateGlobHash(
    context: string,
    patterns: string[],
    excludes?: string[],
    workingDirectory?: string,
) {
    const allErrors: FileError[] = []
    const excludesSafe = excludes ?? []
    const [paths] = await getGlobMatched(
        null,
        workingDirectory,
        patterns,
        excludesSafe,
        allErrors,
    )
    const hashInfo = await calculatePathHashes(
        paths,
        excludesSafe,
        workingDirectory,
        null,
        allErrors,
    )
    const totalSha = shasumStringArray(
        context,
        hashInfo.map(data => data.hash),
    )
    return {
        value: totalSha,
        info: hashInfo,
    }
}

async function calculatePathHashes(
    paths: string[],
    excludes?: string[],
    workingDirectory?: string,
    options?: BuilderCustomOptions,
    allErrors?: FileError[],
    context?: string,
) {
    workingDirectory = workingDirectory ?? ''
    const statProms = paths.map(path => entityStat(path))
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
        const [path, pathStat] = gitObjectResult.value
        if (!pathStat) {
            allErrors.push({
                file: null,
                e: new Error(`src path '${path}' not found ${context ?? ''}`),
            })
            continue
        } else if (pathStat.isDirectory()) {
            const errors: FileError[] = []
            dirProms.push(
                getGlobMatched(
                    options,
                    workingDirectory,
                    [`${path}/**/*`],
                    excludes,
                    errors,
                ),
            )
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
        const [paths, errors] = dirSettle.value
        if (errors) {
            for (const e of errors) {
                allErrors.push(e)
            }
        }
        allFiles.push(...paths)
    }
    const allUniqueFiles = uniqueStringArray(allFiles).sort((a, b) =>
        a.localeCompare(b),
    )
    const settledSha = await Promise.allSettled(
        allUniqueFiles.map(file => shasumFile(file)),
    )
    const fileShasums: string[] = []
    settledSha.forEach(shaResult => {
        if (shaResult.status === 'fulfilled') {
            const [file, shasum] = shaResult.value
            fileShasums.push(shasum)
        }
    })
    return allUniqueFiles.map((file, i) => ({
        file: pathlib.relative(workingDirectory, file),
        hash: fileShasums[i],
    }))
}

function getPublishTargets(
    compo: ComponentManifest,
    config: TypedBuilderConfig,
    options: BuilderCustomOptions,
) {
    const { tag } = options
    const allFullImagePaths: string[] = []
    const ephemeralImageHashedTag = getEphemeralComponentFullpath(compo, config)
    const ephemeralImageCustomTag = getEphemeralComponentFullpath(
        compo,
        config,
        tag,
    )

    allFullImagePaths.push(ephemeralImageHashedTag, ephemeralImageCustomTag)

    const shouldPublish = (flag: boolean | 'ci-only') =>
        flag === true || (flag === 'ci-only' && options.ci)

    if (
        compo.publish &&
        config.is_precommit &&
        shouldPublish(config.docker?.registry?.published?.precommit?.publish) &&
        stringArray(config.docker?.registry?.published?.precommit?.target)
            .length
    ) {
        const publishPaths = getPrecommitComponentPublishPaths(compo, config)
        for (const publishPath of publishPaths) {
            const fullPath = `${publishPath}:${getVariantTag(compo, tag)}`
            allFullImagePaths.push(fullPath)
        }
    }

    if (
        compo.publish &&
        config.is_postcommit &&
        shouldPublish(
            config.docker?.registry?.published?.postcommit?.publish,
        ) &&
        stringArray(config.docker?.registry?.published?.postcommit?.target)
            .length
    ) {
        const publishPaths = getPostcommitComponentPublishPaths(compo, config)
        for (const publishPath of publishPaths) {
            const fullPath = `${publishPath}:${getVariantTag(compo, tag)}`
            allFullImagePaths.push(fullPath)
        }
        if (
            shouldPublish(
                config.docker?.registry?.published?.postcommit?.publish_latest,
            )
        ) {
            for (const publishPath of publishPaths) {
                const fullPath = `${publishPath}:latest`
                allFullImagePaths.push(fullPath)
            }
        }
    }

    const addStaticTargetErrors: Error[] = []
    const addStaticTargets = () => {
        if (
            !options.ci ||
            !compo.docker?.publish_static ||
            !config.docker?.registry?.named ||
            !Object.keys(config.docker?.registry?.named).length
        ) {
            return
        }
        const otherNamedRegistries = config.docker?.registry?.named
        const staticTargetAdd = (otherPublishTargets: OtherNamedPublishMap) => {
            const regNames = Object.keys(otherPublishTargets)
            for (const registryName of regNames) {
                let registry = otherNamedRegistries[registryName]
                if (!registry) {
                    addStaticTargetErrors.push(
                        new Error(
                            `ERROR; registry '${registryName}' does not exist as a registered entry on ` +
                                `builder.config.yml:(docker.registry.named) while parsing the component ` +
                                `manifest at ${compo.manifest_path}:(docker.publish_static.'${registryName}')`,
                        ),
                    )
                    continue
                }
                const { repo, tag, precommit } =
                    otherPublishTargets[registryName]
                if (!precommit && config.is_precommit) {
                    continue
                }
                if (tag === null || tag === undefined) {
                    continue
                }
                while (registry && registry.endsWith('/')) {
                    registry = registry.slice(0, -1)
                }
                while (repo && repo.endsWith('/')) {
                    registry = registry.slice(0, -1)
                }
                while (repo && repo.startsWith('/')) {
                    registry = registry.slice(1)
                }
                const fullPath = `${registry}/${repo ? repo : compo.docker.image_name}:${getVariantTag(compo, tag)}`
                allFullImagePaths.push(fullPath)
            }
        }
        if (
            compo.docker.publish_static &&
            Object.keys(compo.docker.publish_static).length
        ) {
            staticTargetAdd(compo.docker.publish_static)
        }
    }
    addStaticTargets()

    return {
        allFullImagePaths,
        ephemeralImageHashedTag,
        ephemeralImageCustomTag,
        targetErrors: addStaticTargetErrors,
    }
}

async function handlePrebuilts(
    allFullImagePaths: string[],
    compo: ComponentManifest,
    config: TypedBuilderConfig,
    options: BuilderCustomOptions,
) {
    const ephemeralImageHashedTag = getEphemeralComponentFullpath(compo, config)
    const chosenBuilder = await chooseBuilder(config)
    const tmpfile = `${await getTempDir()}/${compo.fullname.replace(/\//g, '_')}.Dockerfile`
    await setFileContent(tmpfile, `FROM ${ephemeralImageHashedTag}`)
    let checkerCmd = `docker buildx build `
    checkerCmd += chosenBuilder ? ` --builder '${chosenBuilder}' ` : ''
    checkerCmd += allFullImagePaths.map(img => ` --tag '${img}'`).join(' ')
    checkerCmd += ` --pull --push -f '${tmpfile}' . `
    const [prebuiltResult] = await runCommand(checkerCmd)
    fs.unlink(tmpfile, () => {})
    const prebuiltExists = prebuiltResult === 0
    return prebuiltExists
}

let lastUsedBuilderIndex = -1
async function chooseBuilder(config: TypedBuilderConfig) {
    let chosenBuilder: string = ''
    if (
        config.docker?.task_assign?.type === 'builder-pool' &&
        stringArray(config.docker?.task_assign?.builder_pool).length
    ) {
        const pool = stringArray(config.docker?.task_assign?.builder_pool)
        if (config.docker?.task_assign?.strategy === 'roundrobin') {
            ++lastUsedBuilderIndex
            lastUsedBuilderIndex %= pool.length
            chosenBuilder = pool[lastUsedBuilderIndex]
        } else if (config.docker?.task_assign?.strategy === 'random') {
            lastUsedBuilderIndex = Math.floor(Math.random() * pool.length)
            chosenBuilder = pool[lastUsedBuilderIndex]
        }
    }
    return chosenBuilder
}

function getGlobMatched(
    options: BuilderCustomOptions,
    workingDirectory: string,
    globexprs: string[],
    ignore: string[],
    errors?: FileError[],
    forEachFile?: <T = any>(
        file: string,
        errors: FileError[],
    ) => Promise<T | void>,
    emptyMatchWarningContext = '',
): Promise<GlobResult> {
    if (!errors) {
        errors = []
    }
    if (!ignore) {
        ignore = []
    }
    ignore = stringArray(ignore)
    return promise<GlobResult>(async resolve => {
        if (!globexprs) {
            return resolve([[], errors])
        }
        workingDirectory = workingDirectory ?? ''
        const globOnly = globexprs.filter(expr => expr.indexOf('*') >= 0)
        const rawPaths = globexprs
            .filter(expr => expr.indexOf('*') === -1)
            .map(path => abspath(workingDirectory, path))
        const existingRawPathsPromise = filterExistingPaths(
            workingDirectory,
            rawPaths,
            errors,
        )
        const excludes = excludesFilter(ignore)
        const globMatchProms = globOnly.map(globexpr =>
            globWithExcludes(workingDirectory, globexpr, excludes),
        )
        const globSettleds = await Promise.allSettled(globMatchProms)
        const files: string[] = []
        for (const settledMatch of globSettleds) {
            if (settledMatch.status === 'rejected') {
                continue
            }
            const [globexpr, paths, error] = settledMatch.value
            if (error) {
                errors.push({
                    file: null,
                    e: new Error(
                        `ERROR: unable to run glob expression '${globOnly.join(', ')}: ${error}`,
                    ),
                })
            }
            if (paths?.length) {
                const uniqueList = uniqueStringArray(
                    paths.map(file => abspath(workingDirectory, file)),
                )
                files.push(...uniqueList)
            }
            if (paths?.length === 0 && emptyMatchWarningContext) {
                options?.log(
                    colors.yellow(
                        `WARNING; '${globexpr}' did not match any file while ${emptyMatchWarningContext}`,
                    ),
                )
            }
        }
        if (errors.length) {
            return resolve([null, errors])
        }
        if (forEachFile) {
            const proms = files.map(filename => forEachFile(filename, errors))
            await Promise.allSettled(proms)
        }
        const [existingRawPaths] = await existingRawPathsPromise
        if (errors.length) {
            return resolve([null, errors])
        }
        const allFiles = existingRawPaths.map(file =>
            abspath(workingDirectory, file),
        )
        allFiles.push(...files)
        const uniqueFullList = uniqueStringArray(allFiles)
        return resolve([uniqueFullList, errors.length ? errors : null])
    })
}

function excludesFilter(excludes: string[]) {
    if (!excludes || excludes.length === 0) {
        return []
    }
    const excludesFiltered = uniqueStringArray(defaultExcludes, excludes).map(
        excl =>
            !excl.startsWith('./') && excl.indexOf('**') === -1
                ? `**/${excl}`
                : excl,
    )
    return excludesFiltered
}

function globWithExcludes(
    workingDirectory: string,
    globexpr: string,
    excludes: string[],
) {
    return promise<[string, string[], Error]>(resolve => {
        fg(globexpr, {
            dot: true,
            cwd: workingDirectory,
            ignore: excludes,
            globstar: true,
        })
            .then(async (files: string[]) => {
                return resolve([globexpr, files, null])
            })
            .catch(e => {
                return resolve([globexpr, null, e])
            })
    })
}

async function filterExistingPaths(
    workingDirectory: string,
    paths: string[],
    errors: FileError[],
): Promise<GlobResult> {
    const rawPathProms = paths.map(path => existingPath(workingDirectory, path))
    const settled = await Promise.allSettled(rawPathProms)
    const existingPaths: string[] = []
    for (let i = 0; i < paths.length; ++i) {
        ;(settled[i] as any)._path = paths[i]
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
export function runCommand(command: string, options?: ExecOptions) {
    if (!options) {
        options = {}
    }
    let exitCode = 0
    return promise<CommandResult>(resolve => {
        exec(command, options, (e, stdout, stderr) => {
            resolve([exitCode, stdout, stderr, e])
        }).on('exit', code => (exitCode = code))
    })
}

function shasumFile(file: string) {
    return promise<[string, string]>(resolve => {
        const fd = fs.createReadStream(file)
        const hash = crypto.createHash('sha512')
        hash.setEncoding('binary')
        hash.update(
            Buffer.from(
                `sha512-truncated-to-32-byte; filename=${pathlib.basename(file)};`,
                'ascii',
            ),
        ) // salting
        fd.on('end', () => {
            hash.end()
            const hashBuffer: Buffer = hash.digest().subarray(0, 32)
            resolve([
                pathlib.relative(process.cwd(), file),
                hashBuffer.toString('hex'),
            ])
        })
        fd.pipe(hash)
    })
}

export function shasumStringArray(context: string, arr: string[]) {
    const hash = crypto.createHash('sha512')
    hash.setEncoding('binary')
    hash.update(
        Buffer.from(`sha512-truncated-to-32-byte; context=${context}`, 'ascii'),
    ) // salting
    hash.update(Buffer.from(arr.join(''), 'ascii'))
    hash.end()
    return hash.digest().subarray(0, 32).toString('hex')
}

export function getFileContent(file: string, errors?: FileError[]) {
    if (!errors) {
        errors = []
    }
    return promise<{ file: string; data: string }>(async resolve => {
        fs.readFile(file, 'utf8', (e, data) => {
            if (e) {
                errors.push({ file, e })
                return resolve({ file, data: null })
            }
            return resolve({ file, data })
        })
    })
}

function dockerCacheFromResolve(imagePath: string) {
    return promise<[boolean, string, string]>(async resolve => {
        const [code, stdout, stderr, e] = await runCommand(
            `docker manifest inspect --insecure '${imagePath}'`,
        )
        resolve(
            code === 0 ? [true, imagePath, null] : [false, imagePath, stderr],
        )
    })
}

export function setFileContent(
    file: string,
    content: string,
    errors?: FileError[],
) {
    if (!errors) {
        errors = []
    }
    return promise<boolean>(async resolve => {
        fs.writeFile(file, content, 'utf8', e => {
            if (e) {
                errors.push({ file, e })
                return resolve(false)
            }
            return resolve(true)
        })
    })
}

export function appendFileContent(
    file: string,
    content: string,
    errors?: FileError[],
) {
    if (!errors) {
        errors = []
    }
    return promise<boolean>(async resolve => {
        fs.appendFile(file, content, 'utf8', e => {
            if (e) {
                errors.push({ file, e })
                return resolve(false)
            }
            return resolve(true)
        })
    })
}

export function existingPath(workingDirectory: string, path: string) {
    return promise<string | Error>(resolve => {
        fs.access(abspath(workingDirectory, path), error => {
            return resolve(!error ? path : error)
        })
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

function stringArray(
    input: string | string[] | null,
    passthruNull = false,
): string[] {
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

function envSubst(expr: string) {
    const e: Error = null
    if (e && expr.indexOf('$') === -1) {
        return expr
    }
    const replaceCountMax = 1000
    for (const envVar of Object.keys(process.env)) {
        const envVal = process.env[envVar]
        const shortForm = `$${envVar}`
        const longForm = `\${${envVar}}`
        let replaceCount = 0
        while (expr.indexOf(shortForm) >= 0 && replaceCount < replaceCountMax) {
            expr = expr.replace(shortForm, envVal)
            ++replaceCount
        }
        while (expr.indexOf(longForm) >= 0 && replaceCount < replaceCountMax) {
            expr = expr.replace(longForm, envVal)
            ++replaceCount
        }
        if (replaceCount >= replaceCountMax) {
            break
        }
    }
    return expr
}

function getVariantTag(compo: ComponentManifest, tag: string) {
    const variantPart =
        compo.variant && compo.variant !== 'default' ? '-' + compo.variant : ''
    return `${tag}${variantPart}`
}

function getEphemeralComponentFullpath(
    compo: ComponentManifest,
    config: TypedBuilderConfig,
    tag?: string,
) {
    const tempRegistry = stringArray(config.docker?.registry?.temp)[0]
    const projPart = compo.project ? compo.project + '/' : ''
    const tagFinal = getVariantTag(compo, `${tag ?? compo.hash}`)
    return `${tempRegistry}/${projPart}${compo.docker.image_name}:${tagFinal}`
}

function getPrecommitComponentPublishPaths(
    compo: ComponentManifest,
    config: TypedBuilderConfig,
) {
    const registries = stringArray(
        config.docker?.registry?.published?.precommit?.target,
    )
    const projPart = compo.project ? compo.project + '/' : ''
    return registries.map(reg => {
        while (reg.endsWith('/')) {
            reg = reg.slice(0, -1)
        }
        return `${reg}/${projPart}${compo.docker.image_name}`
    })
}

function getPostcommitComponentPublishPaths(
    compo: ComponentManifest,
    config: TypedBuilderConfig,
) {
    const registries = stringArray(
        config.docker?.registry?.published?.postcommit?.target,
    )
    const projPart = compo.project ? compo.project + '/' : ''
    return registries.map(reg => {
        while (reg.endsWith('/')) {
            reg = reg.slice(0, -1)
        }
        return `${reg}/${projPart}${compo.docker.image_name}`
    })
}

function findParentComponentByName(
    name: string,
    compoMap: ComponentManifestMap,
) {
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

function copy<T = any>(target: T, options?: BuilderCustomOptions) {
    if (!target) {
        return null
    }
    try {
        return JSON.parse(JSON.stringify(target)) as T
    } catch (e) {
        if (options) {
            options.error(e)
        } else {
            console.error(e)
        }
        return null
    }
}

export async function findBuilderConfig(fromDirectory = process.cwd()) {
    const configChain: BuilderConfigChain = { chain: [], active: null }
    let path = fromDirectory
    let lookFor = ''
    let lookFor2 = ''
    while (pathlib.dirname(path) !== path) {
        lookFor = pathlib.join(path, 'builder.config.yml')
        lookFor2 = pathlib.join(path, 'builder.config.yaml')
        path = pathlib.dirname(path)
        const [ymlResult, yamlResult] = await Promise.allSettled([
            entityStat(lookFor),
            entityStat(lookFor2),
        ])
        let stat: fs.Stats = null
        if (!stat) {
            stat =
                ymlResult.status === 'fulfilled' && ymlResult.value[1]
                    ? ymlResult.value[1]
                    : null
        }
        if (!stat) {
            stat =
                yamlResult.status === 'fulfilled' && yamlResult.value[1]
                    ? yamlResult.value[1]
                    : null
        }
        if (stat) {
            const { data } = await getFileContent(lookFor, [])
            if (!data) {
                continue
            }
            const yamlData = yaml.load(data)
            const configData: BuilderConfig = Array.isArray(yamlData)
                ? yamlData
                : [yamlData]
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
    const activeConfig: TypedBuilderConfig = copy(
        configChain.chain[0]?.config?.[0],
    )
    configChain.active = activeConfig
    return activeConfig
}

export async function resolveBuildEnvironment(
    config: TypedBuilderConfig,
    options: BuilderCustomOptions,
) {
    if (!options) {
        options = {}
    }
    if (!options.ci && !options.precommitContext) {
        options.precommitContext = 'dev'
    }
    if (!config.base_branch) {
        config.base_branch = 'main'
    }
    if (options.headBranch) {
        config.head_branch = options.headBranch
    }
    if (options.baseBranch) {
        config.base_branch = options.baseBranch
    }
    if (!config.head_branch) {
        const [code, stdout, stderr, e] = await runCommand(
            `git rev-parse --abbrev-ref HEAD`,
        )
        if (!e && !stderr && code === 0 && stdout.trim()) {
            config.head_branch = stdout.trim()
        } else {
            config.head_branch = 'main'
        }
    }
    if (options.precommitContext) {
        config.is_precommit = true
        config.is_postcommit = false
    } else {
        if (notSet(config.is_precommit)) {
            config.is_precommit = config.base_branch !== config.head_branch
        }
        if (notSet(config.is_postcommit)) {
            config.is_postcommit = config.base_branch === config.head_branch
        }
    }
    let warned = false
    if (!!config.is_postcommit === !!config.is_precommit) {
        warned = true
        options.log(
            colors.yellow(
                `\nWARNING; 'is_postcommit' and 'is_precommit' ` +
                    `cannot be the same value in 'builder.config.yml'`,
            ),
        )
    }
    config.is_postcommit = !config.is_precommit
    if (warned) {
        options.log(
            colors.yellow(
                `WARNING; overriding 'is_postcommit' to ${config.is_postcommit}`,
            ),
        )
    }
    return config
}

export function getTempDir() {
    return promise(resolve => {
        const dir = `${os.tmpdir()}/${uuidv4()}`
        fs.mkdir(dir, { recursive: true }, e => {
            if (e) {
                return resolve(null)
            }
            resolve(dir)
        })
    })
}

export async function matchFiles(
    files: string[],
    patterns: string[],
    excludes: string[],
) {
    excludes = excludesFilter(excludes)
    const prevCwd = process.cwd()
    const tempDir = await getTempDir()
    const touchFile = (file: string) => {
        return promise<boolean>(resolve => {
            fs.mkdir(pathlib.dirname(file), { recursive: true }, e => {
                if (e) {
                    return resolve(false)
                }
                fs.writeFile(file, '', e2 => {
                    if (e2) {
                        return resolve(false)
                    }
                    resolve(true)
                })
            })
        })
    }
    process.chdir(tempDir)
    await Promise.allSettled(files.map(file => touchFile(file)))
    const matchPattern = (pattern: string) => {
        return promise<string[]>(resolve => {
            fg([pattern, ...excludes], { dot: true })
                .then((matchedFiles: string[]) => {
                    matchedFiles.sort((a, b) => a.localeCompare(b))
                    return resolve(matchedFiles)
                })
                .catch(e => {
                    return resolve([])
                })
        })
    }
    const matchSettleds = await Promise.allSettled(
        patterns.map(pattern => matchPattern(pattern)),
    )
    const allMatched: string[] = []
    for (const matched of matchSettleds) {
        if (matched.status === 'rejected') {
            continue
        }
        allMatched.push(...matched.value)
    }
    const allMatchedUnique = uniqueStringArray(allMatched)
    process.chdir(prevCwd)
    fs.unlink(tempDir, e => {})
    return allMatchedUnique
}
