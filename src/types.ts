export interface ByZone<T> {
  [zoneId: number]: T;
}

/** A zone's collision mesh as downloaded, still compressed the way ximesh stores it. */
export interface ZoneData {
  id: number;
  name: string;
  mesh: ArrayBuffer;
}
