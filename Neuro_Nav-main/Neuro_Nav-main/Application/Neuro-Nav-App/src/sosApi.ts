/** SOS map + hospital helpers (ported from web `app.js`) */

export type HospitalRow = {
  lat: number;
  lon: number;
  name: string;
  addr: string;
};

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function elementLatLon(el: {
  type?: string;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
}): { lat: number; lon: number } | null {
  if (el.type === 'node' && Number.isFinite(el.lat) && Number.isFinite(el.lon)) {
    return { lat: el.lat as number, lon: el.lon as number };
  }
  if (el.center && Number.isFinite(el.center.lat) && Number.isFinite(el.center.lon)) {
    return { lat: el.center.lat, lon: el.center.lon };
  }
  return null;
}

export async function fetchApproxIpLocation(): Promise<{ lat: number; lon: number; label: string }> {
  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), 16000);
  const signal = ac.signal;

  const toRow = (lat: unknown, lon: unknown, labelParts: (string | undefined)[]) => {
    const la = typeof lat === 'string' ? parseFloat(lat) : Number(lat);
    const lo = typeof lon === 'string' ? parseFloat(lon) : Number(lon);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;
    const label = labelParts.filter(Boolean).join(', ') || 'IP estimate';
    return { lat: la, lon: lo, label };
  };

  try {
    try {
      const res = await fetch('https://get.geojs.io/v1/ip/geo.json', { signal });
      if (res.ok) {
        const d = (await res.json()) as {
          latitude?: string;
          longitude?: string;
          city?: string;
          region?: string;
          country?: string;
        };
        const row = toRow(d.latitude, d.longitude, [d.city, d.region, d.country]);
        if (row) return row;
      }
    } catch {
      /* try next */
    }

    try {
      const res = await fetch('https://ipwho.is/', { signal });
      if (res.ok) {
        const d = (await res.json()) as {
          success?: boolean;
          latitude?: number;
          longitude?: number;
          city?: string;
          region?: string;
          country?: string;
        };
        if (d.success) {
          const row = toRow(d.latitude, d.longitude, [d.city, d.region, d.country]);
          if (row) return row;
        }
      }
    } catch {
      /* continue */
    }

    throw new Error('IP location services unreachable. Try Search map with your city.');
  } finally {
    clearTimeout(tid);
  }
}

export async function geocodeWithPhoton(query: string): Promise<{ lat: number; lon: number; label: string }> {
  const q = String(query || '').trim();
  if (!q) throw new Error('Type a city or address in the search box.');

  const url = new URL('https://photon.komoot.io/api/');
  url.searchParams.set('q', q);
  url.searchParams.set('limit', '8');
  url.searchParams.set('lang', 'en');

  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), 16000);
  try {
    const res = await fetch(url.toString(), { signal: ac.signal });
    if (!res.ok) throw new Error(`Place search HTTP ${res.status}`);
    const data = (await res.json()) as {
      features?: { geometry?: { coordinates?: number[] }; properties?: Record<string, string | undefined> }[];
    };
    const f = data.features && data.features[0];
    if (!f || !f.geometry || !f.geometry.coordinates) {
      throw new Error('No matches. Try a larger city or region.');
    }
    const [lon, lat] = f.geometry.coordinates;
    const p = f.properties || {};
    const label =
      [p.name, p.city, p.state, p.country].filter(Boolean).join(', ') || q;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new Error('Invalid coordinates for that place.');
    }
    return { lat, lon, label };
  } finally {
    clearTimeout(tid);
  }
}

async function fetchNearbyHospitalsPhoton(lat: number, lon: number): Promise<HospitalRow[]> {
  const maxKm = 12;
  const url = new URL('https://photon.komoot.io/api/');
  url.searchParams.set('q', 'hospital');
  url.searchParams.set('lat', String(lat));
  url.searchParams.set('lon', String(lon));
  url.searchParams.set('limit', '80');
  url.searchParams.set('lang', 'en');

  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), 22000);
  try {
    const res = await fetch(url.toString(), { signal: ac.signal });
    if (!res.ok) throw new Error(`Photon HTTP ${res.status}`);
    const data = (await res.json()) as {
      features?: {
        geometry?: { coordinates?: number[] };
        properties?: Record<string, string | undefined> & {
          osm_key?: string;
          osm_value?: string;
        };
      }[];
    };
    const rows: HospitalRow[] = [];
    for (const f of data.features || []) {
      const p = f.properties || {};
      const isHospital =
        p.osm_key === 'amenity' && (p.osm_value === 'hospital' || p.osm_value === 'clinic');
      if (!isHospital) continue;
      const c = f.geometry && f.geometry.coordinates;
      if (!c || c.length < 2) continue;
      const [flon, flat] = c;
      if (haversineKm(lat, lon, flat, flon) > maxKm) continue;
      const addr = [p.street, p.district, p.city, p.country].filter(Boolean).join(', ');
      rows.push({
        lat: flat,
        lon: flon,
        name: p.name || (p.osm_value === 'clinic' ? 'Clinic' : 'Hospital'),
        addr,
      });
    }
    return rows;
  } finally {
    clearTimeout(tid);
  }
}

async function fetchNearbyHospitalsOverpass(lat: number, lon: number): Promise<
  {
    type?: string;
    id?: number;
    tags?: Record<string, string>;
    lat?: number;
    lon?: number;
    center?: { lat: number; lon: number };
  }[]
> {
  const radius = 10000;
  const q = `[out:json][timeout:25];
(
  nwr["amenity"="hospital"](around:${radius},${lat},${lon});
);
out center;`;

  const urls = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  let lastErr: Error | null = null;
  for (const url of urls) {
    const ac = new AbortController();
    const tid = setTimeout(() => ac.abort(), 28000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: 'data=' + encodeURIComponent(q),
        signal: ac.signal,
      });
      if (!res.ok) {
        lastErr = new Error(`Overpass HTTP ${res.status}`);
        continue;
      }
      const text = await res.text();
      let data: { elements?: unknown[]; remark?: string };
      try {
        data = JSON.parse(text) as { elements?: object[]; remark?: string };
      } catch {
        const snippet = text.slice(0, 200).replace(/\s+/g, ' ');
        if (/blocked|access denied|rate limit|too many/i.test(snippet)) {
          lastErr = new Error('Overpass blocked or rate-limited this request.');
        } else {
          lastErr = new Error('Invalid response from hospital service.');
        }
        continue;
      }
      if (data.remark && typeof data.remark === 'string') {
        lastErr = new Error(data.remark.trim());
        continue;
      }
      return (data.elements || []) as {
        type?: string;
        id?: number;
        tags?: Record<string, string>;
        lat?: number;
        lon?: number;
        center?: { lat: number; lon: number };
      }[];
    } catch (e) {
      lastErr = e as Error;
    } finally {
      clearTimeout(tid);
    }
  }
  throw lastErr || new Error('Hospital data service unavailable.');
}

export async function fetchHospitalRows(lat: number, lon: number): Promise<HospitalRow[]> {
  try {
    const photonRows = await fetchNearbyHospitalsPhoton(lat, lon);
    if (photonRows.length) return photonRows;
  } catch {
    /* fall through */
  }
  const elements = await fetchNearbyHospitalsOverpass(lat, lon);
  const rows: HospitalRow[] = [];
  const seen = new Set<string>();
  for (const el of elements) {
    const id = `${el.type}/${el.id}`;
    if (seen.has(id)) continue;
    const ll = elementLatLon(el);
    if (!ll) continue;
    seen.add(id);
    rows.push({
      lat: ll.lat,
      lon: ll.lon,
      name: (el.tags && el.tags.name) || 'Hospital',
      addr: [el.tags && el.tags['addr:full'], el.tags && el.tags['addr:street'], el.tags && el.tags['addr:city']]
        .filter(Boolean)
        .join(', '),
    });
  }
  return rows;
}

const detailsCache = new Map<
  string,
  { phone: string; doctor: string; sourceDistanceKm: number }
>();

export async function fetchHospitalDetailsOverpass(lat: number, lon: number): Promise<{
  phone: string;
  doctor: string;
  sourceDistanceKm: number;
}> {
  const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  if (detailsCache.has(key)) return detailsCache.get(key)!;

  const radius = 250;
  const q = `[out:json][timeout:25];
(
  nwr["amenity"="hospital"](around:${radius},${lat},${lon});
  nwr["amenity"="clinic"](around:${radius},${lat},${lon});
);
out center tags;`;

  const urls = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
  let lastErr: Error | null = null;

  for (const url of urls) {
    const ac = new AbortController();
    const tid = setTimeout(() => ac.abort(), 26000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: 'data=' + encodeURIComponent(q),
        signal: ac.signal,
      });
      if (!res.ok) {
        lastErr = new Error(`Overpass HTTP ${res.status}`);
        continue;
      }
      const data = (await res.json()) as {
        elements?: {
          type?: string;
          lat?: number;
          lon?: number;
          center?: { lat: number; lon: number };
          tags?: Record<string, string>;
        }[];
      };
      const els = data && data.elements ? data.elements : [];
      if (!els.length) continue;

      let best: (typeof els)[0] | null = null;
      let bestD = Infinity;
      for (const el of els) {
        const ll = elementLatLon(el);
        if (!ll) continue;
        const dKm = haversineKm(lat, lon, ll.lat, ll.lon);
        if (dKm < bestD) {
          bestD = dKm;
          best = el;
        }
      }
      if (!best) continue;

      const tags = best.tags || {};
      const phone =
        tags.phone ||
        tags['contact:phone'] ||
        tags['contact:phone:mobile'] ||
        tags['phone:mobile'] ||
        tags.fax ||
        tags['contact:fax'] ||
        '';

      const doctor =
        tags.doctor ||
        tags.doctor_name ||
        tags['doctor:full_name'] ||
        tags['doctor:principal'] ||
        tags['staff:doctor'] ||
        tags.medical_doctor ||
        tags.director ||
        tags['medical:director'] ||
        '';

      const detail = {
        phone: phone ? String(phone) : 'Not listed',
        doctor: doctor ? String(doctor) : 'Not listed',
        sourceDistanceKm: bestD,
      };
      detailsCache.set(key, detail);
      return detail;
    } catch (e) {
      lastErr = e as Error;
    } finally {
      clearTimeout(tid);
    }
  }

  throw lastErr || new Error('Hospital details unavailable.');
}

export async function sosDrawRouteMeta(
  fromLat: number,
  fromLon: number,
  toLat: number,
  toLon: number,
): Promise<{ routeText: string; coordinates: { latitude: number; longitude: number }[] }> {
  const url = new URL(
    `https://router.project-osrm.org/route/v1/driving/${fromLon},${fromLat};${toLon},${toLat}`,
  );
  url.searchParams.set('overview', 'full');
  url.searchParams.set('geometries', 'geojson');
  url.searchParams.set('alternatives', 'false');
  url.searchParams.set('steps', 'false');

  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(), 22000);
  try {
    const res = await fetch(url.toString(), { signal: ac.signal });
    if (!res.ok) throw new Error(`OSRM HTTP ${res.status}`);
    const data = (await res.json()) as {
      routes?: { distance?: number; duration?: number; geometry?: { coordinates?: [number, number][] } }[];
    };
    const route = data && data.routes && data.routes[0];
    if (!route || !route.geometry) throw new Error('No route found.');

    const km = route.distance ? route.distance / 1000 : null;
    const min = route.duration ? route.duration / 60 : null;

    const coords =
      route.geometry.coordinates?.map(([lon, lat]) => ({
        latitude: lat,
        longitude: lon,
      })) || [];

    const routeText =
      km != null && min != null
        ? `Fastest route: ${km.toFixed(1)} km • ${Math.max(1, Math.round(min))} min`
        : 'Fastest route ready';

    return { routeText, coordinates: coords };
  } finally {
    clearTimeout(tid);
  }
}
