// "Capture Evidence": what a test report needs from a stopped screen - the forms as pictures, the values of their
// controls, the variables and the stack - written as one Markdown file with the pictures next to it.
// Kept free of the vscode module so it can be tested alone.

export interface ControlRow {
    depth: number;
    name: string;
    type: string;
    text: string;
    visible: boolean;
    enabled: boolean;
    /** The value of an input control ("Checked: True"), when its type has one. */
    value?: string;
    /** The cells of a DataGridView that were read. */
    grid?: { headers: string[]; rows: string[][]; rowCount: number };
}

export interface EvidenceForm {
    name: string;
    type: string;
    title: string;
    /** Picture file name, relative to the Markdown file. */
    screenshot?: string;
    /** Why there is no picture. */
    screenshotProblem?: string;
    controls: ControlRow[];
    /** Not every control was read (the limit was reached). */
    truncated: boolean;
}

export interface EvidenceData {
    time: Date;
    program?: string;
    location?: { name: string; file?: string; line?: number; code?: string };
    stack: string[];
    locals: { name: string; value: string; type?: string }[];
    forms: EvidenceForm[];
    /** SQL statements run since the previous capture, with values filled in. */
    sql: string[];
    /** Forms / controls could not be read (not a WinForms program, ...). */
    formsProblem?: string;
}

/** Controls whose current value is worth showing, and how to read it: property expressions on the control. */
const VALUE_PROPERTIES: Record<string, { label: string; property: string }[]> = {
    CheckBox: [{ label: 'Checked', property: 'Checked.ToString()' }],
    RadioButton: [{ label: 'Checked', property: 'Checked.ToString()' }],
    ComboBox: [{ label: 'SelectedIndex', property: 'SelectedIndex.ToString()' }],
    ListBox: [{ label: 'SelectedIndex', property: 'SelectedIndex.ToString()' }, { label: 'Items', property: 'Items.Count.ToString()' }],
    NumericUpDown: [{ label: 'Value', property: 'Value.ToString()' }],
    DateTimePicker: [{ label: 'Value', property: 'Value.ToString("yyyy-MM-dd HH:mm:ss")' }],
    TabControl: [{ label: 'SelectedIndex', property: 'SelectedIndex.ToString()' }],
    ProgressBar: [{ label: 'Value', property: 'Value.ToString()' }],
    TrackBar: [{ label: 'Value', property: 'Value.ToString()' }],
};

export function valuePropertiesOf(typeName: string): { label: string; property: string }[] {
    return VALUE_PROPERTIES[typeName.slice(typeName.lastIndexOf('.') + 1)] ?? [];
}

/** A file name for a form's picture: letters, digits, "-" and "_" only. */
export function pictureFileName(index: number, name: string): string {
    return `form-${index + 1}-${name.replace(/[^A-Za-z0-9_-]+/g, '_') || 'form'}.png`;
}

/** "2026-11-16 10:05:09" as a folder name: "20261116-100509". */
export function evidenceFolderName(time: Date): string {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${time.getFullYear()}${p(time.getMonth() + 1)}${p(time.getDate())}-${p(time.getHours())}${p(time.getMinutes())}${p(time.getSeconds())}`;
}

const cell = (text: string) => text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');

/** The Markdown file; `t` translates the headings. */
export function buildEvidence(d: EvidenceData, t: (text: string) => string): string {
    const out: string[] = [`# ${t('Evidence')} ${d.time.toLocaleString()}`, ''];
    if (d.program) {
        out.push(`- ${t('Program')}: \`${d.program}\``);
    }
    if (d.location) {
        const where = d.location.file ? ` (${d.location.file}${d.location.line ? `:${d.location.line}` : ''})` : '';
        out.push(`- ${t('Stopped at')}: \`${d.location.name}\`${where}`);
        if (d.location.code) {
            out.push('', '```csharp', d.location.code.trim(), '```');
        }
    }
    out.push('');

    d.forms.forEach((f, i) => {
        out.push(`## ${t('Form')} ${i + 1}: ${f.name || f.type}${f.title ? ` "${f.title}"` : ''}`, '');
        out.push(f.screenshot ? `![${f.name}](${f.screenshot})` : `_${t('No picture')}: ${f.screenshotProblem ?? '?'}_`, '');
        const grids: ControlRow[] = [];
        if (f.controls.length) {
            out.push(`| ${t('Control')} | ${t('Type')} | ${t('Text')} | ${t('Value')} | ${t('State')} |`, '|---|---|---|---|---|');
            for (const c of f.controls) {
                const state = [c.visible ? '' : t('hidden'), c.enabled ? '' : t('disabled')].filter(Boolean).join(', ');
                out.push(`| ${' '.repeat(c.depth)}${cell(c.name || '-')} | ${cell(c.type.slice(c.type.lastIndexOf('.') + 1))} | ${cell(c.text)} | ${cell(c.value ?? '')} | ${state} |`);
                if (c.grid) {
                    grids.push(c);
                }
            }
            out.push('');
        }
        if (f.truncated) {
            out.push(`_${t('Only the first controls were read.')}_`, '');
        }
        for (const g of grids) {
            out.push(`### ${g.name || g.type} (${g.grid!.rowCount} ${t('rows')})`, '');
            out.push(`| ${g.grid!.headers.map(cell).join(' | ')} |`, `|${g.grid!.headers.map(() => '---').join('|')}|`);
            for (const row of g.grid!.rows) {
                out.push(`| ${row.map(cell).join(' | ')} |`);
            }
            out.push('');
        }
    });
    if (d.formsProblem) {
        out.push(`_${t('Forms were not read')}: ${d.formsProblem}_`, '');
    }

    if (d.locals.length) {
        out.push(`## ${t('Variables')}`, '', `| ${t('Name')} | ${t('Value')} | ${t('Type')} |`, '|---|---|---|');
        for (const v of d.locals) {
            out.push(`| ${cell(v.name)} | ${cell(v.value)} | ${cell(v.type ?? '')} |`);
        }
        out.push('');
    }
    if (d.stack.length) {
        out.push(`## ${t('Call stack')}`, '', '```', ...d.stack, '```', '');
    }
    if (d.sql.length) {
        out.push(`## ${t('SQL since the previous capture')}`, '', '```sql', ...d.sql, '```', '');
    }
    return out.join('\n');
}
