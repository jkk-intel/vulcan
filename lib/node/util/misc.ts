import { promise } from 'ts-basis'
import proc from 'child_process'
import fs from 'fs'

type ExecReturn = { exitCode: number; stdout: string; stderr: string }
export function bash(
    cmd: string,
    options?: proc.SpawnOptionsWithoutStdio,
    ioHandlers?: {
        pipeToParent?: boolean
        onStdout?: (data: string) => any
        onStderr?: (data: string) => any
    },
): Promise<ExecReturn> {
    return promise(resolve => {
        const procInst = proc.spawn(cmd, {
            ...(options ?? {}),
            shell: '/bin/bash',
        })
        const stdoutBuffers: Buffer[] = []
        const stderrBuffers: Buffer[] = []
        procInst.on('exit', exitCode => {
            return resolve({
                exitCode,
                stdout: Buffer.concat(stdoutBuffers).toString(),
                stderr: Buffer.concat(stderrBuffers).toString(),
            })
        })
        procInst.stdout.on('data', (data: Buffer) => {
            try {
                stdoutBuffers.push(data)
                if (ioHandlers?.pipeToParent) {
                    process.stdout.write(data)
                }
                ioHandlers?.onStdout?.(data.toString())
            } catch (e) {
                console.error(e)
            }
        })
        procInst.stderr.on('data', (data: Buffer) => {
            try {
                stderrBuffers.push(data)
                if (ioHandlers?.pipeToParent) {
                    process.stderr.write(data)
                }
                ioHandlers?.onStderr?.(data.toString())
            } catch (e) {
                console.error(e)
            }
        })
    })
}

export function getContent(path: string): Promise<string> {
    return promise(resolve => {
        fs.readFile(path, 'utf8', (e, content) => {
            if (e) {
                // console.error(e)
            }
            if (!content) {
                content = ''
            }
            return resolve(content)
        })
    })
}

export function setContent(path: string, text: string): Promise<boolean> {
    return promise(resolve => {
        fs.writeFile(path, text, 'utf8', e => {
            if (e) {
                console.error(e)
            }
            return resolve(e ? false : true)
        })
    })
}

export function appendContent(path: string, text: string): Promise<boolean> {
    return promise(resolve => {
        fs.appendFile(path, text, 'utf8', e => {
            if (e) {
                console.error(e)
            }
            return resolve(e ? false : true)
        })
    })
}

export function mkdir(path: string): Promise<void> {
    return promise(resolve => {
        fs.mkdir(path, { recursive: true }, e => {
            if (e) {
                console.error(e)
            }
            return resolve()
        })
    })
}

export async function rmdir(path: string): Promise<void> {
    await bash(`rm -rf ${path}`)
    return
}

export async function pathExists(path: string): Promise<boolean> {
    try {
        await fs.promises.access(path)
        return true
    } catch (e) {
        return false
    }
}

export async function ls(path: string) {
    return await fs.promises.readdir(path)
}
