// When to stop on a thrown exception: the user's exception breakpoints in VS Code ("All Exceptions" with an optional
// type condition) together with the types checked in the Exception Settings view. VS Code offers no API to change the
// former, so the relay merges both into what netcoredbg gets. Kept free of the vscode module.

export interface ExceptionSettings {
    filters: string[];
    filterOptions: { filterId: string; condition?: string }[];
}

/** netcoredbg's condition syntax: "A, B" stops on those types, "!A, B" on every type except those. */
function parseCondition(condition: string): { negate: boolean; types: string[] } {
    let text = condition.trim();
    const negate = text.startsWith('!');
    if (negate) {
        text = text.slice(1);
    }
    return { negate, types: text.split(/[\s,]+/).filter(Boolean) };
}

/** Whether an exception of this type, thrown, should stop the program. */
export function breaksOnThrow(user: ExceptionSettings, checkedTypes: string[], typeName: string): boolean {
    if (checkedTypes.includes(typeName) || user.filters.includes('all')) {
        return true;
    }
    return user.filterOptions.some((o) => {
        if (o.filterId !== 'all') {
            return false;
        }
        const { negate, types } = parseCondition(o.condition ?? '');
        return types.length === 0 || types.includes(typeName) !== negate;
    });
}

/**
 * The exception filters netcoredbg gets. With the exception log on it gets every thrown exception and the relay
 * decides with breaksOnThrow; otherwise the checked types are merged into the "All Exceptions" condition.
 */
export function exceptionFiltersForDebugger(user: ExceptionSettings, checkedTypes: string[], exceptionLog: boolean): ExceptionSettings {
    if (exceptionLog) {
        return { filters: [...new Set([...user.filters, 'all'])], filterOptions: user.filterOptions.filter((o) => o.filterId !== 'all') };
    }
    if (checkedTypes.length === 0 || user.filters.includes('all')) {
        return user;
    }
    const allOption = user.filterOptions.find((o) => o.filterId === 'all');
    const others = user.filterOptions.filter((o) => o !== allOption);
    if (!allOption) {
        return { filters: user.filters, filterOptions: [...others, { filterId: 'all', condition: checkedTypes.join(', ') }] };
    }
    const { negate, types } = parseCondition(allOption.condition ?? '');
    if (types.length === 0) {
        return user; // every exception already
    }
    const merged = negate
        ? `!${types.filter((t) => !checkedTypes.includes(t)).join(', ')}`
        : [...new Set([...types, ...checkedTypes])].join(', ');
    // "!" with nothing left to exclude means every exception.
    const condition = merged === '!' ? '' : merged;
    return { filters: user.filters, filterOptions: [...others, { ...allOption, condition }] };
}
