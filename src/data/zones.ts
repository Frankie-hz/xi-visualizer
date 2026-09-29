import zonesRaw from "./zones.json";

export interface ZoneInfo {
  id: number;
  name: string;
}

const zoneLookup: { [zoneId: number]: ZoneInfo; } = {};

for (const zone of zonesRaw) {
  zoneLookup[zone.id] = {
    id: zone.id,
    name: zone.name,
  };
}

export default zoneLookup;

const folderName = (name: string) => name.toLowerCase().replace(/['#()[\]]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
const byFolder = new Map(Object.values(zoneLookup).map(z => [folderName(z.name), z]));

/** The zone an LSB data/zones folder is, by name. A handful of folders match no zone name. */
export const zoneOfFolder = (folder: string): ZoneInfo | undefined => byFolder.get(folder.toLowerCase());
