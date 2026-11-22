// Downloaded symbols: the engine (and netcoredbg with patch 0009) loads PDBs by module MVID from the folders listed in
// NETDBG_SYMBOL_DIRS. Kept free of the vscode module.

/** Environment variable the engine reads the symbol folders from (separated by `;`). */
export const SYMBOL_DIRS_ENV = 'NETDBG_SYMBOL_DIRS';