import { Command } from 'commander'
import packageJSON from '../package.json'
import { catchUnhandledRejections } from '../util/cli-base'
import { bash, getContent, pathExists, setContent } from '../util/misc'
import { getFileContent } from '../builder/builder'
const colors = require('colors/safe')

type CLIArgs = {
    packageJsonFile: string
    version?: string
    venvInventoryPath?: string
    npmCachePath?: string
    use?: boolean
}

async function main() {
    catchUnhandledRejections()

    process.env.NVM_DIR = `${process.env.TOOLCHAINS_DIR}/.nvm`

    const cli = new Command()
    const binName = process.env.PACKAGE_BIN_NAME
        ? process.env.PACKAGE_BIN_NAME
        : Object.keys(packageJSON.bin)[0]

    cli.name(binName)
        .description(`setup node dependency based on package.json file`)
        .requiredOption(
            '-f, --package-json-file <packageJsonFile>',
            'package.json file to ascertain target dependencies',
            'package.json',
        )
        .option('-v, --version <version>', 'node version', '')
        .option(
            '-p, --venv-inventory-path <venvInventoryPath>',
            'path to keep multiple node venvs',
            `${process.env.TOOLCHAINS_DIR}/node_venvs`,
        )
        .option(
            '-c, --npm-cache-path <npmCachePath>',
            'path to keep multiple node venvs',
            `${process.env.TOOLCHAINS_DIR}/node_venvs/npm_cache`,
        )
        .option(
            '--use',
            'whether to use the node venv in current working directory',
        )
        .action(async (options: CLIArgs) => {
            if (!(await pathExists(options.packageJsonFile))) {
                console.error(
                    `-f --package-json-file '${options.packageJsonFile}' not found`,
                )
                return process.exit(1)
            }
            const venvName = await getVenvName(options.packageJsonFile)
            const venvFolder = `${options.venvInventoryPath}/${venvName}`
            await bash(`mkdir -p '${venvFolder}'`)
            await prepareNvm(options.packageJsonFile, venvFolder)
            await installVenv(options, venvFolder)
            if (options.use) {
                await useNodeVenv(venvFolder, options.packageJsonFile)
            }
            console.log(venvFolder)
        })

    cli.parse()
}

async function getVenvName(packageJsonFile: string) {
    const { stdout: shasum } = await bash(`\
        shasum -a 256 "${packageJsonFile}" | cut -d' ' -f1
    `)
    return shasum.trim().slice(0, 24)
}

async function installVenv(options: CLIArgs, venvFolder: string) {
    const lastUsed = await getContent(`${venvFolder}/last_used`)
    if (lastUsed) {
        await setContent(
            `${venvFolder}/last_used`,
            Math.floor(Date.now() / 1000) + '',
        )
        return
    }
    await bash(`cp '${options.packageJsonFile}' '${venvFolder}'/`)

    const pkgLockFile = options.packageJsonFile
        .split('package.json')
        .join('package-lock.json')
    if (await pathExists(pkgLockFile)) {
        await bash(`cp '${pkgLockFile}' '${venvFolder}'/`)
    }

    const npmRcFile = options.packageJsonFile
        .split('package.json')
        .join('.npmrc')
    if (await pathExists(npmRcFile)) {
        await bash(`cp '${npmRcFile}' '${venvFolder}'/`)
    }

    const envCopy = JSON.parse(JSON.stringify(process.env))
    const { stdout, stderr } = await bash(
        `\
        . "$NVM_DIR/nvm.sh"
        mkdir -p "$VENV_FOLDER" "$NPM_CACHE_PATH" "$TMPDIR"
        cd "$VENV_FOLDER"
        export NPM_CONFIG_PREFIX="$VENV_FOLDER"
        echo "NPM_CONFIG_PREFIX=$NPM_CONFIG_PREFIX"
        echo "Installing packages with node $(node -v) (npm v$(npm -v))"
        echo "Contents of $PACKAGE_JSON_FILE:"
        cat package.json
        npm config set legacy-peer-deps true || :
        npm i --include=dev
    `,
        {
            env: Object.assign(envCopy, {
                PACKAGE_JSON_FILE: options.packageJsonFile,
                NPM_CONFIG_CACHE: options.npmCachePath,
                TMPDIR: `${options.venvInventoryPath}/tmp`,
                VENV_FOLDER: venvFolder,
            }),
            cwd: venvFolder,
        },
    )
    await setContent(`${venvFolder}/install_stdout`, stdout)
    await setContent(`${venvFolder}/install_stderr`, stderr)
    await setContent(
        `${venvFolder}/last_used`,
        Math.floor(Date.now() / 1000) + '',
    )
}

async function useNodeVenv(venvFolder: string, packageJsonFile: string) {
    await bash(`\
        PKG_JSON_DIR="$(dirname "$(realpath '${packageJsonFile}')")"
        cd "$PKG_JSON_DIR"
        if [ ! -d node_modules ]; then
            ln -s "${venvFolder}/node_modules" node_modules
        fi
    `)
}

async function prepareNvm(packageJsonFile: string, venvFolder: string) {
    const nvmVersion = '0.40.0'
    if (!process.env.NVM_DIR) {
        return
    }
    if (!(await pathExists(`${process.env.NVM_DIR}/nvm.sh`))) {
        await bash(`\
            echo 'here'
            mkdir -p "$NVM_DIR"
            export HOME="$(realpath "$NVM_DIR/..")"
            curl -fkL https://raw.githubusercontent.com/nvm-sh/nvm/v${nvmVersion}/install.sh | bash
        `)
    }
    const ltsVersion = await resolveNodeLtsVersion()
    const { stdout: nodePath } = await bash(`\
        . "$NVM_DIR/nvm.sh"
        which node
    `)
    if (nodePath.indexOf('/.nvm/') === -1) {
        await bash(`\
            . "$NVM_DIR/nvm.sh"
            nvm install '${ltsVersion}'
            rm -rf '${venvFolder}'
            mkdir -p '${venvFolder}'
            PKG_JSON_DIR="$(dirname "$(realpath package.json)")"
            cp '${packageJsonFile}' '${venvFolder}'/
            [[ -f "$PKG_JSON_DIR/.npmrc" ]] && \
                cp "$PKG_JSON_DIR/.npmrc" '${venvFolder}'/
        `)
    }
}

async function resolveNodeLtsVersion() {
    let ltsInfoFinal = ''
    const ltsInfoFile = `${process.env.TOOLCHAINS_DIR}/node_lts_info`
    const { data: ltsInfo } = await getFileContent(ltsInfoFile)
    if (
        !ltsInfo ||
        ltsInfo.split('|')[0]?.trim() === '' ||
        Date.now() - parseInt(ltsInfo.split('|')[1]) > 259200000
    ) {
        const { stdout, stderr, exitCode } = await bash(`\
            . "$NVM_DIR/nvm.sh"
            nvm ls-remote | grep 'Latest LTS' | tail -n1 | awk '$1=$1'
         `)
        const version = stdout
            .split(' ')
            .filter(a => a.startsWith('v'))[0]
            .split('v')[1]
            .split('.')
            .map(a => parseInt(a.replace(/\D/g, '')) + '')
            .join('.')
        if (stdout) {
            await setContent(ltsInfoFile, `${version}|${Date.now()}`)
            ltsInfoFinal = version
        }
    } else if (ltsInfo) {
        ltsInfoFinal = ltsInfo.split('|')[0]
    }
    return ltsInfoFinal
}

main()
