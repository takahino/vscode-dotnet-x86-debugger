// VS Code's side of a DAP relay whose debugger is the scripted stand-in (fakeDebugger), for unit tests of the relay.

import * as path from 'path';
import { DapProxy, ProxyOptions } from '../../dapProxy';
import { FakeScenario } from './fakeDebugger';

/* eslint-disable @typescript-eslint/no-explicit-any */

export type Message = { type: string; seq?: number; command?: string; event?: string; request_seq?: number; success?: boolean; body?: any };

/** VS Code's side of a relay that runs fakeDebugger with the scenario. */
export class Client {
    readonly messages: Message[] = [];
    private readonly proxy: DapProxy;
    private readonly waiters: { match: (m: Message) => boolean; resolve: (m: Message) => void }[] = [];
    private seq = 1;

    constructor(scenario: FakeScenario, sqlMethods: string[] = [], options: ProxyOptions = {}) {
        const fake = path.join(__dirname, 'fakeDebugger.js');
        // The stand-in reads its scenario from its environment (the relay passes its own environment on).
        process.env.FAKE_SCENARIO = JSON.stringify(scenario);
        this.proxy = new DapProxy(process.execPath, [fake], __dirname, (m) => this.receive(m as Message), () => undefined, { sqlMethods, ...options });
    }

    request(command: string, args: Record<string, unknown> = {}): Promise<Message> {
        const seq = this.seq++;
        const response = this.waitFor((m) => m.type === 'response' && m.request_seq === seq, `response to ${command}`);
        this.proxy.fromClient({ type: 'request', seq, command, arguments: args });
        return response;
    }

    waitFor(match: (m: Message) => boolean, what = 'message'): Promise<Message> {
        const earlier = this.messages.find(match);
        if (earlier && what.startsWith('event')) {
            return Promise.resolve(earlier);
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), 10_000);
            this.waiters.push({ match, resolve: (m) => { clearTimeout(timer); resolve(m); } });
        });
    }

    events(name: string): Message[] {
        return this.messages.filter((m) => m.type === 'event' && m.event === name);
    }

    /** initialize, launch, then configurationDone (and whatever `beforeDone` sends in between). */
    async start(beforeDone: () => Promise<unknown> = async () => undefined): Promise<void> {
        await this.request('initialize', { adapterID: 'dotnet-x86' });
        await this.request('launch', { program: 'App.exe' });
        await beforeDone();
        await this.request('configurationDone');
    }

    /** What the relay sent to the stand-in so far. */
    async sentToDebugger(): Promise<{ command: string; arguments?: any }[]> {
        return (await this.request('fake.requests')).body.requests;
    }

    async close(): Promise<void> {
        this.proxy.dispose();
        await Promise.race([this.proxy.whenExited(), new Promise((r) => setTimeout(r, 5_000))]);
    }

    private receive(m: Message): void {
        this.messages.push(m);
        for (let i = this.waiters.length - 1; i >= 0; i--) {
            if (this.waiters[i].match(m)) {
                this.waiters.splice(i, 1)[0].resolve(m);
            }
        }
    }
}

/** A stop or the end of the program. */
export const stopped = (m: Message) => m.type === 'event' && (m.event === 'stopped' || m.event === 'terminated');
