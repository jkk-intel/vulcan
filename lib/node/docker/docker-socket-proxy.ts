import * as http from 'http'
import Express from 'express'
const socketPath = `${process.env.HOME}/.docker/run/docker.sock`
const app = Express()

app.all('*', (req, res) => {
    const [_, ver, domain, op1, op2] = req.path.split('/')
    if (req.httpVersionMajor === 2) {
        return
    }
    console.log(`================== NEW REQUEST ================`)
    console.log(
        `[${new Date().toLocaleString()}]`,
        '[REQUEST]',
        req.method,
        req.path,
        req.query,
        req.headers,
    )
    if (req.path === '/_ping') {
        return res.end('')
    }

    const chunks: Buffer[] = []
    if (req.headers.connection === 'Upgrade') {
        let socketFound = false
        if (req.path === '/grpc') {
            return res.end()
        }
        const proxyRequest = http.request(
            {
                method: req.method,
                path: `${req.path}?${new URLSearchParams(req.query as any).toString()}`,
                headers: req.headers,
                socketPath,
            },
            () => {},
        )
        req.on('data', data => {
            if (socketFound) {
                return
            }
            proxyRequest.write(data)
        })
        proxyRequest.on('upgrade', (proxyRes, socket, head) => {
            socketFound = true
            res.status(proxyRes.statusCode)
            for (const headerName of Object.keys(proxyRes.headers)) {
                res.header(headerName, proxyRes.headers[headerName])
            }
            res.flushHeaders()
            req.socket.on('data', data => {
                socket.write(data)
            })
            socket.on('data', data => {
                res.socket.write(data)
            })
            socket.on('end', () => {
                proxyRequest.end()
                res.end()
                req.socket.end()
            })
            socket.on('error', e => {
                console.error(e)
                proxyRequest.end()
                res.end()
            })
        })
    } else {
        req.on('data', data => {
            chunks.push(data)
        })
        req.on('end', () => {
            const bodyBuffer = Buffer.concat(chunks)
            const body = bodyBuffer.toString('utf8')
            if (body && (body.startsWith('{') || body.startsWith('['))) {
                try {
                    const parsedReqObj = JSON.parse(body)
                    console.log('request', parsedReqObj)
                } catch (e) {}
            }
            const proxyRequest = http.request(
                {
                    method: req.method,
                    path: `${req.path}?${new URLSearchParams(req.query as any).toString()}`,
                    headers: req.headers,
                    socketPath,
                },
                proxyRes => {
                    let dataTime = 0
                    console.log(`STATUS: ${proxyRes.statusCode}`)
                    res.status(proxyRes.statusCode)
                    for (const headerName of Object.keys(proxyRes.headers)) {
                        res.header(headerName, proxyRes.headers[headerName])
                    }
                    res.flushHeaders()
                    const proxyChunks: Buffer[] = []
                    proxyRes.on('data', (data, d) => {
                        dataTime = Date.now()
                        res.write(data)
                        proxyChunks.push(data)
                    })
                    proxyRes.on('end', () => {
                        const proxyBody =
                            Buffer.concat(proxyChunks).toString('utf8')
                        try {
                            const parsedResObj = JSON.parse(proxyBody)
                            console.log('response', parsedResObj)
                        } catch (e) {
                            console.log('response', proxyBody)
                        }
                        res.end()
                    })
                    proxyRes.on('close', () => {
                        res.end()
                    })
                    proxyRes.on('error', e => {
                        console.error(e)
                        res.end()
                    })
                },
            )
            proxyRequest.write(bodyBuffer)
            proxyRequest.end()
        })
    }
})

http.createServer(app).listen(80, function () {
    // fs.chmodSync(sock, '777');
    console.log('Express server listening on ' + 80)
})
