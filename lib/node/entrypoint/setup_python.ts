import { Command } from 'commander'
import packageJSON from '../package.json'
import { catchUnhandledRejections } from '../util/cli-base'
import {
    bash,
    getContent,
    ls,
    mkdir,
    pathExists,
    setContent,
} from '../util/misc'
import { getFileContent } from '../builder/builder'
import { promise, randBase34 } from 'ts-basis'
const colors = require('colors/safe')

type CLIArgs = {
    requirementsFile: string
    version?: string
    venvInventoryPath?: string
    pipCachePath?: string
    use?: boolean
}

async function main() {
    catchUnhandledRejections()

    process.env.PYENV_DIR = `${process.env.TOOLCHAINS_DIR}/.pyenv`

    const cli = new Command()
    const binName = process.env.PACKAGE_BIN_NAME
        ? process.env.PACKAGE_BIN_NAME
        : Object.keys(packageJSON.bin)[0]

    cli.name(binName)
        .description(`setup python dependency based on requirements file`)
        .requiredOption(
            '-f, --requirements-file <requirementsFile>',
            'requirements file to ascertain target dependencies',
            'requirements.txt',
        )
        .option('-v, --version <version>', 'python version', '3.12')
        .option(
            '-p, --venv-inventory-path <venvInventoryPath>',
            'path to keep multiple python venvs',
            `${process.env.TOOLCHAINS_DIR}/python_venvs`,
        )
        .option(
            '-c, --pip-cache-path <pipCachePath>',
            'path to keep multiple python venvs',
            `${process.env.TOOLCHAINS_DIR}/python_venvs/pip_cache`,
        )
        .action(async (options: CLIArgs) => {
            if (!(await pathExists(options.requirementsFile))) {
                console.error(
                    `-f --requirements-file '${options.requirementsFile}' not found`,
                )
                return process.exit(1)
            }
            const venvName = await getVenvName(options.requirementsFile)
            const venvFolder = `${options.venvInventoryPath}/${venvName}`
            await bash(`mkdir -p '${venvFolder}'`)
            await preparePyenv()
            await installPythonVersion(options)
            await installVenv(options, venvFolder)
            console.log(venvFolder)
        })

    cli.parse()
}

async function getVenvName(requirementsFile: string) {
    const { stdout: shasum } = await bash(`\
        shasum -a 256 "${requirementsFile}" | cut -d' ' -f1
    `)
    return shasum.trim().slice(0, 24)
}

async function installPythonVersion(options: CLIArgs) {
    const tmpFolder = `${process.env.TOOLCHAINS_DIR}/tmp`
    await mkdir(tmpFolder)
    const installId = randBase34(12)
    const installLogFile = `${tmpFolder}/install.${options.version}.log`
    const installCompleteFile = `${tmpFolder}/install.${options.version}.complete.log`
    const waitForInstall = async () => {
        const startTime = Date.now()
        while (Date.now() - startTime < 600_000) {
            if (await pathExists(installCompleteFile)) {
                return
            }
            await promise(resolve => setTimeout(resolve, 1000))
        }
    }

    if (await pathExists(installCompleteFile)) {
        return
    }

    let installLogFileContent: string
    if (await pathExists(installLogFile)) {
        installLogFileContent = await getContent(installLogFile)
        if (!installLogFileContent) {
            await bash(`rm -rf '${installLogFile}'`)
        } else {
            const t = parseInt(installLogFileContent.split('|')[1])
            if (Date.now() - t > 180_000) {
                await bash(`rm -rf '${installLogFile}'`)
            } else {
                return await waitForInstall()        
            }
        }
    }

    await setContent(installLogFile, `${installId}|${Date.now()}`)
    installLogFileContent = await getContent(installLogFile)
    if (!installLogFileContent?.startsWith(installId)) {
        return await waitForInstall()
    }

    await bash(`\
        ${includePyenvPath()}
        export https_proxy="$HTTPS_PROXY"
        export PYTHON_BUILD_CACHE_PATH="${process.env.TOOLCHAINS_DIR}/pyenv_cache"
        mkdir -p "$PYTHON_BUILD_CACHE_PATH"
        pyenv install --skip-existing "${options.version}" 2>&1 | tee -a "${installLogFile}"
    `)

    const installLogContent = await getContent(installLogFile)
    if (installLogContent.indexOf('ModuleNotFoundError') >= 0) {
        const versionLine = installLogContent
            .split('\n')
            .filter(a => a.indexOf('Installing Python-') >= 0)[0]
        const versionNumbers = versionLine.split('-')[1].split('.')
        const version = `${versionNumbers[0]}.${versionNumbers[1]}.${versionNumbers[2]}`
        const installDir = `${process.env.PYENV_DIR}/version/${version}`
        await bash(`rm -rf "${installDir}"`)
        throw new Error(`Unable to install python verion ${version}`)
    }

    await setContent(installCompleteFile, Date.now() + '')
    await bash(`rm -rf '${installLogFile}'`)
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

    await bash(`\
        ${includePyenvPath()}
        pyenv local "${options.version}"
        pyenv exec python -m venv "${venvFolder}" || echo blocks
    `)

    await bash(`cp '${options.requirementsFile}' '${venvFolder}'/`)

    const envCopy = JSON.parse(JSON.stringify(process.env))
    const { stdout, stderr } = await bash(
        `\
        ${includePyenvPath()}
        mkdir -p "$PIP_CACHE_DIR" "$TMPDIR"
        source "${venvFolder}/bin/activate"

        export PYTHON_BUILD_CACHE_PATH="${process.env.TOOLCHAINS_DIR}/pyenv_cache"
    
        # get up-to-date wheel & bdist
        pip install wheel setuptools
        
        # resolve packages
        echo "Installing packages with python, $(pyenv version)"
        echo "$(pip -V)"
        echo ""
        echo "Contents of $REQUIREMENTS_FILE:"
        cat "$REQUIREMENTS_FILE"
        echo ""
        echo ""
        pip install -r "$REQUIREMENTS_FILE"
    `,
        {
            env: Object.assign(envCopy, {
                REQUIREMENTS_FILE: options.requirementsFile,
                PIP_CACHE_PATH: options.pipCachePath,
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

async function preparePyenv() {
    if (!process.env.PYENV_DIR) {
        return
    }
    if (
        !(await pathExists(process.env.PYENV_DIR)) ||
        (await ls(process.env.PYENV_DIR)).length === 0
    ) {
        await bash(`\
            export HOME="${process.env.TOOLCHAINS_DIR}"
            curl -fkL https://github.com/pyenv/pyenv-installer/raw/master/bin/pyenv-installer | bash
        `)
    }
}

function includePyenvPath() {
    if (process.env.PATH.indexOf(process.env.PYENV_DIR) >= 0) {
        return ''
    }
    return `export PATH="$PYENV_DIR/bin:$PATH"`
}

main()
