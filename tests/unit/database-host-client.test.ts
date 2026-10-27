import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { DatabaseHostClient } from '../../src/main/database-host-client'
import type { HostInput } from '../../src/shared/host-rpc'

class Host extends EventEmitter {
  sent: HostInput[] = []
  request(index: number) { const message = this.sent[index]; if (!('id' in message)) throw new Error('Expected a request'); return message }
  kill = vi.fn(() => true)
  postMessage = vi.fn((message: HostInput) => { this.sent.push(message) })
}
afterEach(() => vi.useRealTimers())
function fixture() {
  const process = new Host(), launch = vi.fn(() => process)
  const callbacks = { event: vi.fn(), backup: vi.fn(), transfer: vi.fn(), exited: vi.fn() }
  return { process, launch, callbacks, client: new DatabaseHostClient(launch, callbacks) }
}
async function ready(process: Host) { process.emit('message', { ready: true }); await Promise.resolve(); await Promise.resolve() }

it('starts one host for concurrent calls and routes reversed replies by request identity', async () => {
  const { client, process, launch } = fixture()
  const history = client.call('history'), settings = client.call('historySettings')
  await ready(process)
  expect(launch).toHaveBeenCalledTimes(1)
  const first = process.request(0), second = process.request(1)
  process.emit('message', { id: second.id, ok: true, value: { enabled: false } })
  process.emit('message', { id: first.id, ok: true, value: [] })
  expect(await history).toEqual([]); expect(await settings).toEqual({ enabled: false })
  process.emit('exit')
})

it('permits only one acknowledgement for a token issued by the current host', async () => {
  const { client, process, callbacks } = fixture()
  const operation = client.call('history'); await ready(process)
  const event = { type: 'rows', sessionId: 'session', queryId: 'query', index: 0, rows: [['x']] }
  process.emit('message', { event, token: 'owned-token' })
  client.acknowledge('unissued'); client.acknowledge('owned-token'); client.acknowledge('owned-token')
  expect(callbacks.event).toHaveBeenCalledWith(event, 'owned-token')
  expect(process.sent.filter(message => 'ack' in message)).toEqual([{ ack: 'owned-token' }])
  process.emit('message', { id: process.request(0).id, ok: true, value: [] }); await operation
  process.emit('exit')
  client.acknowledge('owned-token')
  expect(process.sent).toHaveLength(2)
})

it('retains a failed startup until actual exit and allows a later explicit replacement', async () => {
  const { client, process, launch, callbacks } = fixture()
  const first = expect(client.call('history')).rejects.toThrow('disk is full')
  process.emit('message', { startupError: 'Workspace disk is full' }); await first
  await expect(client.call('history')).rejects.toThrow('disk is full')
  expect(launch).toHaveBeenCalledTimes(1); expect(process.kill).toHaveBeenCalledTimes(1)
  process.emit('exit'); expect(callbacks.exited).toHaveBeenCalledWith('Workspace disk is full')
  const replacement = new Host(); launch.mockReturnValueOnce(replacement)
  const operation = client.call('history'); await ready(replacement)
  replacement.emit('message', { id: replacement.request(0).id, ok: true, value: [] })
  expect(await operation).toEqual([]); expect(launch).toHaveBeenCalledTimes(2)
  replacement.emit('exit')
})

it('rejects all outstanding calls on host exit and waits for settlement during renderer recovery', async () => {
  const { client, process } = fixture()
  const first = expect(client.call('history')).rejects.toThrow('unknown outcome')
  const second = expect(client.call('historySettings')).rejects.toThrow('unknown outcome')
  await ready(process)
  let stopped = false
  const stopping = client.stop().then(() => { stopped = true })
  await Promise.resolve(); expect(stopped).toBe(false)
  expect(process.kill).toHaveBeenCalledTimes(1)
  process.emit('exit'); await Promise.all([first, second, stopping])
  expect(stopped).toBe(true)
})

it('keeps write ownership beyond read timeouts and ignores late read responses', async () => {
  vi.useFakeTimers()
  const { client, process } = fixture()
  const read = expect(client.call('history')).rejects.toThrow('Operation timed out')
  const write = client.call('connect', { engine: 'postgres', name: 'fixture', host: 'local', port: 5432, database: '', user: 'fixture', password: '', tls: 'disable' })
  const rejectedWrite = expect(write).rejects.toThrow('unknown outcome')
  await ready(process)
  await vi.advanceTimersByTimeAsync(60001)
  await read
  expect(process.kill).not.toHaveBeenCalled()
  process.emit('message', { id: process.request(0).id, ok: true, value: ['late'] })
  process.emit('exit'); await rejectedWrite
})

it('allows explicit retry after synchronous launch failure without retaining rejected readiness', async () => {
  const { client, process, launch } = fixture()
  launch.mockImplementationOnce(() => { throw new Error('fork refused') })
  await expect(client.call('history')).rejects.toThrow('fork refused')
  const retry = client.call('history'); await ready(process)
  process.emit('message', { id: process.request(0).id, ok: true, value: [] })
  expect(await retry).toEqual([]); expect(launch).toHaveBeenCalledTimes(2)
  process.emit('exit')
})

it('reports host loss when exit wins the readiness continuation without sending a request', async () => {
  const { client, process } = fixture()
  const operation = expect(client.call('history')).rejects.toThrow('unknown outcome')
  process.emit('message', { ready: true })
  process.emit('exit')
  await operation
  expect(process.sent).toEqual([])
})

it('removes a failed send and its timer without replaying the request', async () => {
  vi.useFakeTimers()
  const { client, process } = fixture()
  process.postMessage.mockImplementationOnce(() => { throw new Error('Channel closed during send') })
  const operation = expect(client.call('history')).rejects.toThrow('Channel closed during send')
  await ready(process); await operation
  expect(process.postMessage).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
  process.emit('exit')
})
