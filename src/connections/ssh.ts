import { Client } from 'ssh2'
import { createServer, type Socket } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { Duplex } from 'node:stream'
import type { ConnectionConfig } from '../shared/contracts'
import type { Endpoint } from './transport'

export interface Tunnel { address: Endpoint; close(): void }
export async function openTunnel(config: ConnectionConfig, lost: () => void): Promise<Tunnel> {
  const ssh = config.ssh!
  const client = new Client(), sockets = new Set<Duplex>()
  let closed = false, connected = false, mismatch = false
  // Oracle's supported HTTP CONNECT transport preserves the original TLS name
  // and keeps listener redirects confined to this proxy as well.
  const server = config.engine === 'oracle' ? createHttpServer((_req, res) => { res.writeHead(405); res.end() }) : createServer()
  function close() {
    if (closed) return
    closed = true; server.close(); for (const socket of sockets) socket.destroy(); sockets.clear(); client.destroy()
  }
  function failed() { if (!closed) { close(); if (connected) lost() } }
  function forward(socket: Duplex, head?: Buffer) {
    if (closed || sockets.size >= 64) { socket.destroy(); return }
    sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); socket.pause()
    const timer = setTimeout(() => socket.destroy(), 15000)
    socket.once('close', () => clearTimeout(timer))
    client.forwardOut('127.0.0.1', (socket as Socket).remotePort ?? 0, ssh.destinationHost ?? config.host, config.port, (error, stream) => {
      clearTimeout(timer)
      if (error || closed || socket.destroyed) { stream?.destroy(); socket.destroy(); return }
      sockets.add(stream); stream.on('error', () => socket.destroy()); stream.once('close', () => { sockets.delete(stream); socket.destroy() })
      socket.once('close', () => stream.destroy())
      if (head) { socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) stream.write(head) }
      socket.pipe(stream); stream.pipe(socket); socket.resume()
    })
  }
  if (config.engine === 'oracle') {
    server.on('connect', (request, socket, head) => {
      if (request.url !== `${config.host}:${config.port}` && request.url !== `[${config.host}]:${config.port}`) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return }
      forward(socket, head)
    })
  } else server.on('connection', socket => forward(socket))
  server.on('error', failed); client.on('error', failed); client.on('close', failed)
  let key: Buffer | undefined
  try {
    if (ssh.authentication === 'private-key') {
      if (!ssh.privateKeyPath || !isAbsolute(ssh.privateKeyPath)) throw new Error('Choose an absolute path to an SSH private key.')
      const file = await open(ssh.privateKeyPath, 'r')
      try { const stat = await file.stat(); if (!stat.isFile() || stat.size > 256 * 1024) throw new Error('SSH private keys must be regular files smaller than 256 KiB.'); key = await file.readFile() } finally { await file.close() }
    }
    const agent = process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined)
    if (ssh.authentication === 'agent' && !agent) throw new Error('No SSH agent is available. Set SSH_AUTH_SOCK before launching Db Commander or select a private key.')
    await new Promise<void>((resolve, reject) => {
      const rejectConnection = () => reject(new Error(mismatch ? 'SSH host key does not match the pinned fingerprint. Verify the key with the server administrator.' : 'SSH connection or authentication failed. Check the server, user and authentication settings.'))
      client.once('error', rejectConnection); client.once('close', rejectConnection)
      client.once('ready', () => { client.off('error', rejectConnection); client.off('close', rejectConnection); resolve() })
      client.connect({ host: ssh.host, port: ssh.port, username: ssh.user, readyTimeout: 15000, keepaliveInterval: 10000, keepaliveCountMax: 3,
        hostVerifier: (key: Buffer) => { const matches = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}` === ssh.fingerprint; mismatch = !matches; return matches },
        ...(ssh.authentication === 'password' ? { password: config.sshSecrets?.password, authHandler: ['password'] } : ssh.authentication === 'private-key' ? { privateKey: key, passphrase: config.sshSecrets?.passphrase, authHandler: ['publickey'] } : { agent, authHandler: ['agent'] }) })
    })
    if (closed) throw new Error('SSH connection closed before forwarding started.')
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() }) })
    if (closed) throw new Error('SSH connection closed before forwarding started.')
    connected = true
    return { address: { host: '127.0.0.1', port: (server.address() as { port: number }).port }, close }
  } catch (error) { close(); throw error } finally { key?.fill(0) }
}
