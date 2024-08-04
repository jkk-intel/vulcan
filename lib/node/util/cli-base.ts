import { globalRoot } from 'ts-basis'

let catchUnhandledRejectionsDone = false
export function catchUnhandledRejections() {
    if (catchUnhandledRejectionsDone) {
        return
    }
    catchUnhandledRejectionsDone = true
    globalRoot.on('unhandledRejection', (e: Error, prom) => {
        console.error(e)
    })
}
