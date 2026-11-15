// A stand-in for netcoredbg in unit tests of the DAP relay: run with node, it answers DAP on stdin / stdout from a
// script given in the FAKE_SCENARIO environment variable, so the relay's own logic can be tested without a debugger.
// Not a test file itself (the test runner only picks *.test.js).
//
// The program "stops" at scenario.stops in turn: the first after configurationDone, each next one after a continue
// (then "terminated"). stackTrace and evaluate answer from the current stop. setFunctionBreakpoints gives every name
// a lasting id, as netcoredbg does, and reports each as bound right away. "fake.requests" answers with every request
// received so far, for the tests to check what the relay sent.

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface FakeFrame {
    id: number;
    name: string;
    source?: { path: string };
    line?: number;
}

export interface FakeStop {
    reason: string;
    frames: FakeFrame[];
    /** Expression -> what evaluate answers (expressions not listed fail). */
    values?: Record<string, { result: string; type?: string; variablesReference?: number }>;
    /** What exceptionInfo answers at a stop with reason "exception". */
    exception?: { typeName: string; message: string; breakMode?: string };
    /** variablesReference of the "Locals" scope of every frame. */
    localsReference?: number;
}

export interface FakeScenario {
    stops: FakeStop[];
    variables?: Record<number, { name: string; value: string }[]>;
}

const DELIMITER = '\r\n\r\n';

function main(): void {
    const scenario: FakeScenario = JSON.parse(process.env.FAKE_SCENARIO ?? '{"stops":[]}');
    const received: { command: string; arguments?: any }[] = [];
    const breakpointIds = new Map<string, number>();
    let nextId = 1;
    let seq = 1;
    let stopIndex = -1;
    let buffer = Buffer.alloc(0);

    const send = (message: any) => {
        const body = Buffer.from(JSON.stringify({ seq: seq++, ...message }), 'utf8');
        process.stdout.write(`Content-Length: ${body.length}${DELIMITER}`);
        process.stdout.write(body);
    };
    const respond = (request: any, body: any = {}, success = true, message?: string) =>
        send({ type: 'response', request_seq: request.seq, command: request.command, success, message, body });
    const event = (name: string, body: any = {}) => send({ type: 'event', event: name, body });
    const stop = () => scenario.stops[stopIndex];
    const nextStop = () => {
        stopIndex++;
        if (stopIndex < scenario.stops.length) {
            event('stopped', { reason: stop().reason, threadId: 1, allThreadsStopped: true });
        } else {
            event('terminated');
        }
    };

    const handle = (request: any) => {
        received.push({ command: request.command, arguments: request.arguments });
        const args = request.arguments ?? {};
        switch (request.command) {
            case 'initialize':
                respond(request, { supportsFunctionBreakpoints: true, exceptionBreakpointFilters: [] });
                event('initialized');
                break;
            case 'configurationDone':
                respond(request);
                nextStop();
                break;
            case 'setFunctionBreakpoints': {
                const breakpoints = (args.breakpoints ?? []).map((b: any) => {
                    const key = `${b.name}${b.anyCode ? '*' : ''}`;
                    if (!breakpointIds.has(key)) {
                        breakpointIds.set(key, nextId++);
                    }
                    return { id: breakpointIds.get(key), verified: false, line: 0 };
                });
                respond(request, { breakpoints });
                for (const b of breakpoints) {
                    event('breakpoint', { reason: 'changed', breakpoint: { ...b, verified: true } });
                }
                break;
            }
            case 'setBreakpoints': {
                const breakpoints = (args.breakpoints ?? []).map((b: any) => {
                    const key = `${String(args.source?.path).toLowerCase()}:${b.line}`;
                    if (!breakpointIds.has(key)) {
                        breakpointIds.set(key, nextId++);
                    }
                    return { id: breakpointIds.get(key), verified: true, line: b.line, source: args.source };
                });
                respond(request, { breakpoints });
                break;
            }
            case 'exceptionInfo': {
                const e = stop()?.exception;
                respond(request, e
                    ? { exceptionId: e.typeName, description: `${e.typeName}: ${e.message}`, breakMode: e.breakMode ?? 'always', details: { fullTypeName: e.typeName, message: e.message, stackTrace: '   at Program.Main()' } }
                    : {}, Boolean(e));
                break;
            }
            case 'scopes':
                respond(request, { scopes: stop()?.localsReference ? [{ name: 'Locals', variablesReference: stop().localsReference }] : [] });
                break;
            case 'stackTrace': {
                const start = args.startFrame ?? 0;
                const frames = (stop()?.frames ?? []).slice(start, args.levels ? start + args.levels : undefined);
                respond(request, { stackFrames: frames, totalFrames: stop()?.frames.length ?? 0 });
                break;
            }
            case 'evaluate': {
                const value = stop()?.values?.[args.expression];
                if (value) {
                    respond(request, { result: value.result, type: value.type, variablesReference: value.variablesReference ?? 0 });
                } else {
                    respond(request, {}, false, `error: The name '${args.expression}' does not exist in the current context`);
                }
                break;
            }
            case 'variables':
                respond(request, { variables: scenario.variables?.[args.variablesReference] ?? [] });
                break;
            case 'continue':
                respond(request, { allThreadsContinued: true });
                event('continued', { threadId: 1, allThreadsContinued: true });
                nextStop();
                break;
            case 'fake.requests':
                respond(request, { requests: received.slice(0, -1) });
                break;
            case 'disconnect':
                respond(request);
                process.exit(0);
                break;
            default:
                respond(request);
        }
    };

    process.stdin.on('data', (data: Buffer) => {
        buffer = Buffer.concat([buffer, data]);
        for (;;) {
            const headerEnd = buffer.indexOf(DELIMITER);
            if (headerEnd < 0) {
                return;
            }
            const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString('ascii'))?.[1] ?? 0);
            const start = headerEnd + DELIMITER.length;
            if (buffer.length < start + length) {
                return;
            }
            const message = JSON.parse(buffer.subarray(start, start + length).toString('utf8'));
            buffer = buffer.subarray(start + length);
            handle(message);
        }
    });
}

if (require.main === module) {
    main();
}
