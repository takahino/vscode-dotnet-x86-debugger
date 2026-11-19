// The contract between the extension and its debug engine (dotnet-x86dbg), and the custom messages the extension's DAP
// relay (DapProxy) adds on top of it. docs/engine-api.html and docs/engine-api.json are generated from this file
// (npm run docs:api): the interfaces become JSON Schemas, their JSDoc the descriptions. Kept free of the vscode module.
//
// Layers:   VS Code  <-- DAP -->  DapProxy (in the extension)  <-- DAP over stdin/stdout -->  dotnet-x86dbg.exe
// Messages tagged `@handledBy engine` / `@sentBy engine` cross the engine boundary; `proxy` ones stay in the extension.
//
// Tags read by the generator (scripts/gen-engine-api.js):
//   @request <command>   arguments of a request      @response <command>  body of its response
//   @event <name>        body of an event            @handledBy / @sentBy engine | proxy
//   @arguments launch | attach                        (the arguments of those requests)

/* ----------------------------------------------------------------------------------------------------------------
 * launch / attach
 * ---------------------------------------------------------------------------------------------------------------- */

/**
 * Arguments of `launch` as the engine receives them. The extension resolves launch.json first: a `.dll` program becomes
 * `program: <dotnet.exe of the chosen bitness>, args: [<dll>, ...]`, and a .NET Framework exe gets `__dotnetFramework`.
 * launch.json properties that only the extension reads (`architecture`, `sourceFileMap`, `sourceSearchPaths`,
 * `processName`, `waitTimeout`) are not listed here.
 * @arguments launch
 */
export interface LaunchArguments {
    /** Full path of the exe to start (a .NET apphost, a .NET Framework exe, or dotnet.exe). */
    program: string;
    /** Command-line arguments. */
    args?: string[];
    /** Working directory of the program. */
    cwd?: string;
    /** Environment variables added for the program. `null` removes a variable. */
    env?: Record<string, string | null>;
    /** Stop at the first line of the user's `Main` (also for `async Main`). */
    stopAtEntry?: boolean;
    /** Only modules with symbols, without `DebuggerNonUserCode` / `DebuggerHidden` / `DebuggerStepThrough`, are user code (default true). */
    justMyCode?: boolean;
    /** Step over property accessors and operators when stepping in (default true). */
    enableStepFiltering?: boolean;
    /** Options for evaluating expressions. */
    expressionEvaluationOptions?: ExpressionEvaluationOptions;
    /** Edit and Continue (default true): modules of a Debug build with symbols are loaded so that `dotnetX86.applyChanges` can update them. The extension sets it from `dotnetX86.editAndContinue.enabled` unless launch.json does. */
    editAndContinue?: boolean;
    /** Set by the extension when `program` is a .NET Framework exe: the engine starts it with the .NET Framework CLR (no .NET runtime needed). */
    __dotnetFramework?: boolean;
}

/**
 * Arguments of `attach`. The process must have its runtime (coreclr.dll or clr.dll) loaded and be of the engine's bitness.
 * @arguments attach
 */
export interface AttachArguments {
    /** Process id. A string is accepted too (`${command:pickProcess}` returns one). */
    processId: number | string;
    /** As in launch. */
    justMyCode?: boolean;
    /** As in launch. */
    enableStepFiltering?: boolean;
    /** As in launch. */
    expressionEvaluationOptions?: ExpressionEvaluationOptions;
}

/** The same option as the C# extension's debugger (vsdbg). */
export interface ExpressionEvaluationOptions {
    /**
     * Run property getters and `ToString()` / `DebuggerDisplay` to show values (default true). When false, properties come
     * with `presentationHint.lazy` and run only when expanded; explicit evaluations (watch, hover, console) still run code.
     */
    allowImplicitFuncEval?: boolean;
}

/* ----------------------------------------------------------------------------------------------------------------
 * Custom requests the engine handles (the request and response shapes of the former netcoredbg patches 0008, 0010-0012)
 * ---------------------------------------------------------------------------------------------------------------- */

/**
 * Gives the object a value refers to an id (`$1`) that stays valid while the program runs (a weak GC handle: it does not
 * keep the object alive, and reads `null` once the object is collected). In expressions the extension writes `$1` as
 * `__DOTNETX86_OBJID_1`; values of objects with an id end with ` {$1}`.
 * @request dotnetX86.makeObjectId
 * @handledBy engine
 */
export interface MakeObjectIdArguments {
    /** A variable's `variablesReference` (from `variables`, `evaluate` or `scopes`). */
    variablesReference: number;
}

/** @response dotnetX86.makeObjectId */
export interface MakeObjectIdResponse {
    /** The new id (1, 2, ...); the same object asked twice keeps its first id. */
    id: number;
}

/**
 * Freezes or thaws a thread: a frozen thread stays suspended across `continue`, steps and evaluations until thawed.
 * @request dotnetX86.freezeThread
 * @handledBy engine
 */
export interface FreezeThreadArguments {
    /** The thread (`threads`' id, the OS thread id). */
    threadId: number;
    /** true freezes (default), false thaws. */
    frozen?: boolean;
}

/**
 * Counts the objects on the GC heap by type, while the program is stopped. Fails while a GC is in progress.
 * @request dotnetX86.heapStats
 * @handledBy engine
 */
export interface HeapStatsArguments {}

/** @response dotnetX86.heapStats */
export interface HeapStatsResponse {
    /** Largest total size first. Free space between objects is counted under the name `?`. */
    types: HeapTypeStatistics[];
}

export interface HeapTypeStatistics {
    /** Type name as the Variables view shows it (`System.Collections.Generic.List<int>`). */
    name: string;
    /** Number of objects. */
    count: number;
    /** Total size in bytes. */
    size: number;
}

/**
 * For the types that hold a native handle in a field, counts the objects and those whose handle is not 0 (not disposed).
 * The field may be declared by a base type (`Bitmap` holds `Image._nativeImage`).
 * @request dotnetX86.handleStats
 * @handledBy engine
 */
export interface HandleStatsArguments {
    /** The fields to look at, by declaring type (`Namespace.Name`) and field name. */
    fields: { type: string; field: string }[];
}

/** @response dotnetX86.handleStats */
export interface HandleStatsResponse {
    /** By type name; types without one of the fields are left out. */
    types: { name: string; count: number; live: number; field: string }[];
}

/**
 * Edit and Continue: applies the saved edits of the program's C# sources to the program, without restarting (launched,
 * not attached; a Debug build). The engine has its helper (`encdelta`, run with the Roslyn of the installed .NET SDK 9+)
 * build the change against the sources as they were when debugging started, applies it with `ApplyChanges`, and moves
 * breakpoints to the new code. Changed methods run the new code from their next call; a method that is running moves
 * to the new code at its next statement unless that statement's line was changed. A running program is paused for the
 * moment it takes. Also sends `dotnetX86.changesApplied`, `output` and, when applied, `invalidated`.
 * @request dotnetX86.applyChanges
 * @handledBy engine
 */
export interface ApplyChangesArguments {
    /** The saved files (paths as the PDB has them; the relay maps them through `sourceFileMap`). Omitted: every source of the program. */
    files?: string[];
}

/** @response dotnetX86.applyChanges */
export interface ApplyChangesResponse {
    /** `applied`, `noChanges`, `rude` (an edit that needs a restart), `errors` (compile errors) or `failed`. */
    status: 'applied' | 'noChanges' | 'rude' | 'errors' | 'failed';
    /** One-line summary for the user. */
    message: string;
    /** The modules changed and how many methods each. */
    applied: { module: string; methods: number }[];
    /** Where an edit cannot be applied, or a compile error (line and column from 1). */
    problems: { file: string; line: number; column: number; message: string }[];
    /** Further reasons, one per line (the helper could not start, the source changed before debugging, ...). */
    details: string[];
}

/* ----------------------------------------------------------------------------------------------------------------
 * Custom requests the relay handles (never sent to the engine)
 * ---------------------------------------------------------------------------------------------------------------- */

/**
 * The exception types checked in the Exception Settings view changed: the relay stops on these when they are thrown.
 * @request dotnetX86.setExceptionTypes
 * @handledBy proxy
 */
export interface SetExceptionTypesArguments {
    /** Full type names (`System.InvalidOperationException`). */
    types: string[];
}

/**
 * Pauses the program because this UI thread stopped answering for `ms`; the stop is reported on that thread with the
 * description "UI not responding for N s".
 * @request dotnetX86.pauseForFreeze
 * @handledBy proxy
 */
export interface PauseForFreezeArguments {
    threadId: number;
    ms: number;
}

/**
 * Traces the firing of event handlers without stopping (function breakpoints the relay continues from).
 * @request dotnetX86.setEventTrace
 * @handledBy proxy
 */
export interface SetEventTraceArguments {
    /** The handlers to trace (added to those already traced). */
    handlers?: { breakpointName: string; label: string; event?: string; control?: string }[];
    /** Stop tracing every handler. */
    clear?: boolean;
}

/* ----------------------------------------------------------------------------------------------------------------
 * Events
 * ---------------------------------------------------------------------------------------------------------------- */

/**
 * Sent once the program is started or attached to (after the `configurationDone` response). The extension starts the
 * memory graph and the UI freeze watch with `systemProcessId`.
 * @event process
 * @sentBy engine
 */
export interface ProcessEventBody {
    /** The program's path (launch) or the process's exe (attach). */
    name: string;
    systemProcessId: number;
    isLocalProcess: true;
    startMethod: 'launch' | 'attach';
}

/**
 * Standard DAP `stopped`. The engine sends `breakpoint` (also function breakpoints), `step`, `exception`, `pause` (also
 * `Debugger.Break()`) and `entry`; the relay sends `goto`, `data breakpoint` (Break on Value Change) and `step`.
 * @event stopped
 * @sentBy engine
 */
export interface StoppedEventBody {
    reason: 'breakpoint' | 'step' | 'exception' | 'pause' | 'entry' | 'goto' | 'data breakpoint';
    threadId: number;
    allThreadsStopped?: boolean;
    description?: string;
    text?: string;
    hitBreakpointIds?: number[];
}

/**
 * Standard DAP `output`. Categories: `stdout` / `stderr` (the program's output, decoded as UTF-8 while it is valid, else
 * in the console code page), `console` (Debug.WriteLine and the engine's notes), `important` (an evaluation that had to
 * run the other threads to finish).
 * @event output
 * @sentBy engine
 */
export interface OutputEventBody {
    category: 'stdout' | 'stderr' | 'console' | 'important';
    output: string;
}

/**
 * Sent once after `initialize` when the engine was started with `--mcp-listen` (setting `dotnetX86.mcp.enabled`): where
 * AI clients can control this session through MCP (Streamable HTTP, JSON answers only). The extension offers it to VS
 * Code's AI as an HTTP MCP server. The engine also writes it to `%LOCALAPPDATA%\dotnet-x86dbg\mcp\<enginePid>.json`
 * (removed on exit), where `dotnet-x86dbg --mcp-connect` finds it for AI clients outside VS Code.
 * @event dotnetX86.mcpEndpoint
 * @sentBy engine
 */
export interface McpEndpointEventBody {
    /** `http://127.0.0.1:<port>/mcp`. Requests from a web page (an `Origin` other than localhost or VS Code) are refused. */
    url: string;
    /** Required as `Authorization: Bearer <token>`; made anew for every engine. */
    token: string;
    /** Process id of the engine. */
    enginePid: number;
}

/**
 * The result of applying code changes (Edit and Continue), whether VS Code asked (`dotnetX86.applyChanges`) or an AI
 * client did through MCP (`debug_apply_changes`). The body is the response of `dotnetX86.applyChanges`.
 * @event dotnetX86.changesApplied
 * @sentBy engine
 */
export interface ChangesAppliedEventBody {
    /** As in the response of `dotnetX86.applyChanges`. */
    status: 'applied' | 'noChanges' | 'rude' | 'errors' | 'failed';
    /** One-line summary. */
    message: string;
    /** The modules changed. */
    applied: { module: string; methods: number }[];
    /** Problems with their place. */
    problems: { file: string; line: number; column: number; message: string }[];
    /** Further reasons. */
    details: string[];
}

/**
 * Values of a `#track:` logpoint hit, or the time of a `#timer-start:` / `#timer-end:` section.
 * @event dotnetX86.trackedValues
 * @sentBy proxy
 */
export interface TrackedValuesEventBody {
    source: { path?: string; name?: string };
    line: number;
    /** Milliseconds since the epoch. */
    time: number;
    values: { expression: string; value: string; type?: string; error?: string }[];
}

/**
 * A temporary (`#once`) breakpoint was hit: the extension removes it from VS Code's list.
 * @event dotnetX86.removeBreakpoint
 * @sentBy proxy
 */
export interface RemoveBreakpointEventBody {
    source: { path?: string; name?: string };
    line: number;
}

/**
 * An exception was thrown (exception log): sent for every throw while the log is on, whether the program stops or not.
 * @event dotnetX86.exceptionThrown
 * @sentBy proxy
 */
export interface ExceptionThrownEventBody {
    time: number;
    typeName: string;
    message: string;
    /** `always` (thrown), `unhandled`, `userUnhandled`. */
    breakMode: string;
    /** Whether the program stopped for it. */
    stopped: boolean;
    functionName?: string;
    source?: { path?: string; name?: string };
    line?: number;
    /** Call stack and local variables at the throw (when exceptionLog.captureLocals is on). */
    snapshot?: unknown;
}

/**
 * A statement read from a database command (SQL log), with its parameters and the frames that ran it.
 * @event dotnetX86.sqlExecuted
 * @sentBy proxy
 */
export interface SqlExecutedEventBody {
    time: number;
    threadId: number;
    /** The provider method that ran it (`System.Data.SqlClient.SqlCommand.ExecuteReader`). */
    method: string;
    /** The command's type. */
    typeName: string;
    commandText: string;
    /** `Text`, `StoredProcedure`, `TableDirect`. */
    commandType: string;
    parameters: { name: string; kind: 'null' | 'string' | 'number' | 'datetime' | 'binary' | 'other'; value: string; direction: string }[];
    /** ODP.NET: parameters bound by name. */
    bindByName?: boolean;
    dataSource?: string;
    /** Not every parameter was read. */
    truncated?: boolean;
    frames: { name: string; source?: { path?: string; name?: string }; line?: number }[];
}

/**
 * A traced event handler ran (event trace).
 * @event dotnetX86.controlEvent
 * @sentBy proxy
 */
export interface ControlEventEventBody {
    time: number;
    threadId: number;
    events: string[];
    labels: string[];
    controls: string[];
    sender?: string;
    handler: string;
    source?: { path?: string; name?: string };
    line?: number;
}

/* ----------------------------------------------------------------------------------------------------------------
 * Standard DAP requests, capabilities, environment and value conventions (data: listed in the generated document)
 * ---------------------------------------------------------------------------------------------------------------- */

/** A standard DAP request: who handles it, and what the extension relies on. */
export interface StandardRequest {
    command: string;
    /** `engine`: passed through to the engine. `proxy`: answered by the relay. `both`: the relay rewrites or adds to it. */
    handledBy: 'engine' | 'proxy' | 'both';
    notes: string;
}

export const STANDARD_REQUESTS: readonly StandardRequest[] = [
    { command: 'initialize', handledBy: 'engine', notes: 'Answers with the capabilities below, then sends `initialized`. Reads `supportsInvalidatedEvent`.' },
    { command: 'launch', handledBy: 'engine', notes: 'Checks the program (exists, bitness of the engine, .NET Framework 4.x) and remembers it; starts it at `configurationDone`.' },
    { command: 'attach', handledBy: 'engine', notes: 'Checks the process (runtime loaded, bitness of the engine); attaches at `configurationDone`.' },
    { command: 'configurationDone', handledBy: 'both', notes: 'Starts or attaches, then sends `process`. The relay first sets the SQL log\'s function breakpoints.' },
    { command: 'setBreakpoints', handledBy: 'both', notes: '`condition` is a C# expression evaluated in the stopped program. The relay keeps `hitCondition`, `logMessage` and the `#once` / `#after` / `#changed` / `#caller` conditions to itself.' },
    { command: 'setFunctionBreakpoints', handledBy: 'both', notes: '`Type.Method`, `Method`, `Namespace.Type.Method` (all overloads). `anyCode: true` binds outside user code too (SQL log, event trace). The relay adds its own breakpoints and cuts the response back to VS Code\'s.' },
    { command: 'setExceptionBreakpoints', handledBy: 'both', notes: 'Filters `all` and `user-unhandled`; `filterOptions[].condition` is `A, B` or `!A, B` (type names).' },
    { command: 'exceptionInfo', handledBy: 'engine', notes: '`exceptionId` is `CLR/<type>`, `breakMode` `always` / `unhandled` / `userUnhandled`, `details` with `message`, `stackTrace`, `innerException`.' },
    { command: 'threads', handledBy: 'engine', notes: 'The OS thread id is the DAP thread id. Names are `Thread.Name`; else the process\'s first thread is `Main Thread` (listed first) and the others `<No name>`.' },
    { command: 'stackTrace', handledBy: 'engine', notes: 'Every managed frame, named `Namespace.Type.Method()` with the real type arguments; `startFrame` / `levels` page them.' },
    { command: 'scopes', handledBy: 'engine', notes: 'One scope, `Locals`. A step over a call puts `<Type.Method> returned` first.' },
    { command: 'variables', handledBy: 'engine', notes: 'See the value conventions. Children carry `evaluateName`. `Static members` and `Raw View` are nodes of their own.' },
    { command: 'evaluate', handledBy: 'both', notes: 'C# expressions with the compiler\'s values and types (lambdas, LINQ, `await` waited synchronously, pointers). The relay rewrites `$N` object ids.' },
    { command: 'setVariable', handledBy: 'engine', notes: 'The value is a C# expression.' },
    { command: 'setExpression', handledBy: 'engine', notes: 'Assigns to any assignable expression.' },
    { command: 'continue', handledBy: 'engine', notes: 'Frozen threads stay suspended.' },
    { command: 'next', handledBy: 'engine', notes: 'Steps over `await` to the same method\'s continuation.' },
    { command: 'stepIn', handledBy: 'both', notes: 'With `targetId`, the relay steps into the chosen call (Step Into Specific).' },
    { command: 'stepOut', handledBy: 'engine', notes: 'From an async method, returns to the awaiting caller.' },
    { command: 'stepInTargets', handledBy: 'proxy', notes: 'The calls on the line, in the order they run.' },
    { command: 'pause', handledBy: 'engine', notes: 'Stops every thread (reason `pause`).' },
    { command: 'gotoTargets', handledBy: 'engine', notes: 'The lines of the same method that can be the next statement.' },
    { command: 'goto', handledBy: 'both', notes: 'The engine moves the instruction pointer; the relay sends the `stopped` (reason `goto`).' },
    { command: 'dataBreakpointInfo', handledBy: 'proxy', notes: 'Break on Value Change, emulated with breakpoints on the lines that write the variable.' },
    { command: 'cancel', handledBy: 'engine', notes: 'Cancels a running evaluation.' },
    { command: 'terminate', handledBy: 'engine', notes: 'Ends the program; `exited` and `terminated` follow.' },
    { command: 'disconnect', handledBy: 'engine', notes: 'Ends a launched program, detaches from an attached one (`terminateDebuggee` overrides).' },
];

/** The engine's `initialize` response: only implemented features are true. */
export const ENGINE_CAPABILITIES = {
    supportsConfigurationDoneRequest: true,
    supportsFunctionBreakpoints: true,
    supportsConditionalBreakpoints: true,
    supportsEvaluateForHovers: true,
    supportsSetVariable: true,
    supportsSetExpression: true,
    supportsExceptionInfoRequest: true,
    supportsExceptionFilterOptions: true,
    supportsGotoTargetsRequest: true,
    supportTerminateDebuggee: true,
    supportsTerminateRequest: true,
    supportsCancelRequest: true,
    /** Custom: `dotnetX86.applyChanges` (Edit and Continue). */
    dotnetX86SupportsApplyChanges: true,
    exceptionBreakpointFilters: [{ filter: 'all', label: 'all' }, { filter: 'user-unhandled', label: 'user-unhandled' }],
} as const;

/** Command line and environment the extension starts the engine with. */
export const ENGINE_STARTUP: readonly { name: string; notes: string }[] = [
    { name: '--interpreter=vscode', notes: 'DAP over stdin / stdout (the default; accepted for netcoredbg compatibility).' },
    { name: '--log=<file>', notes: 'Writes the DAP traffic and the engine\'s own log, flushed per line (setting `dotnetX86.trace`).' },
    { name: '--mcp-listen', notes: 'Also accepts MCP on 127.0.0.1 with a token, and sends `dotnetX86.mcpEndpoint` (setting `dotnetX86.mcp.enabled`). The tools drive this session; VS Code follows through the usual DAP events.' },
    { name: '--mcp-connect[=<enginePid>]', notes: 'Not used by the extension: run by AI clients outside VS Code, a stdio MCP server that relays to the latest engine started with `--mcp-listen` (or the given one).' },
    { name: 'NETCOREDBG_SYMBOL_DIRS', notes: 'Environment variable: folders (separated by `;`) searched first for PDBs, by module MVID (decompiled and downloaded symbols).' },
];

/** How the engine writes values; the extension parses these strings. */
export const VALUE_CONVENTIONS: readonly { what: string; rule: string }[] = [
    { what: 'Objects', rule: '`{Namespace.Type}`, or the `DebuggerDisplay` text; `DateTime`, `TimeSpan`, `Guid` and the like as `{ToString()}`.' },
    { what: 'Strings and chars', rule: 'Strings as C# literals (`"a\\"b"`); chars as the code and the literal (`120 \'x\'`).' },
    { what: 'null', rule: '`null`.' },
    { what: 'Arrays and collections', rule: '`{int[3]}`; collections with a DebuggerDisplay show it (`Count = 3`).' },
    { what: 'Object ids', rule: 'A value with an id ends with ` {$N}`; in expressions `$N` is sent as `__DOTNETX86_OBJID_N`.' },
    { what: 'Enums', rule: 'Member names (`Read, Write` for flags); unnamed values as the number in the underlying type (`-6`).' },
    { what: 'Pointers', rule: 'The pointed value, with the pointer type in `type` (`int*`); `null` for 0.' },
    { what: 'Exceptions from evaluations', rule: 'The result is the exception object (`{System.InvalidOperationException}`); errors fail the request with a message saying what to do.' },
    { what: 'Void calls', rule: '`Expression has been evaluated and has no value` with type `void`.' },
];
