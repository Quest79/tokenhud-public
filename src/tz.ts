// Display time zone (Settings: local or UTC). Pages read it through tzOpt() so a change applies on the next redraw.
let utc = false;
export const setTz = (v: string) => { utc = v === 'UTC'; };
export const tzOpt = (): { timeZone?: string } => (utc ? { timeZone: 'UTC' } : {});
export const tzName = () => (utc ? 'UTC' : Intl.DateTimeFormat().resolvedOptions().timeZone.split('/').pop() || 'local');
