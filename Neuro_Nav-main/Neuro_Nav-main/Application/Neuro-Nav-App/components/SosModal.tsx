import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import MapView, { Circle, Marker, Polyline } from 'react-native-maps';
import * as Location from 'expo-location';
import type { HospitalRow } from '../src/sosApi';
import {
  fetchApproxIpLocation,
  fetchHospitalDetailsOverpass,
  fetchHospitalRows,
  geocodeWithPhoton,
  sosDrawRouteMeta,
} from '../src/sosApi';
import { colors } from '../src/theme';

type Props = {
  visible: boolean;
  onClose: () => void;
  onUserLocation: (lat: number | null, lon: number | null) => void;
  onLog: (msg: string) => void;
};

export function SosModal({ visible, onClose, onUserLocation, onLog }: Props) {
  const [status, setStatus] = useState('Getting your location…');
  const [search, setSearch] = useState('');
  const [region, setRegion] = useState({
    latitude: 20,
    longitude: 0,
    latitudeDelta: 80,
    longitudeDelta: 80,
  });
  const [userPos, setUserPos] = useState<{ lat: number; lon: number } | null>(null);
  const [hospitals, setHospitals] = useState<HospitalRow[]>([]);
  const [route, setRoute] = useState<{ latitude: number; longitude: number }[] | null>(null);
  const [hospName, setHospName] = useState('—');
  const [hospPhone, setHospPhone] = useState('—');
  const [hospDoctor, setHospDoctor] = useState('—');
  const [hospRoute, setHospRoute] = useState('—');
  const [busy, setBusy] = useState(false);

  const fitMap = useCallback((lat: number, lon: number, rows: HospitalRow[]) => {
    const pts = rows.map((r) => ({ latitude: r.lat, longitude: r.lon }));
    if (!pts.length) {
      setRegion({
        latitude: lat,
        longitude: lon,
        latitudeDelta: 0.12,
        longitudeDelta: 0.12,
      });
      return;
    }
    const lats = [lat, ...pts.map((p) => p.latitude)];
    const lons = [lon, ...pts.map((p) => p.longitude)];
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLon = Math.min(...lons);
    const maxLon = Math.max(...lons);
    const midLat = (minLat + maxLat) / 2;
    const midLon = (minLon + maxLon) / 2;
    const dLat = Math.max(0.02, (maxLat - minLat) * 1.35);
    const dLon = Math.max(0.02, (maxLon - minLon) * 1.35);
    setRegion({
      latitude: midLat,
      longitude: midLon,
      latitudeDelta: dLat,
      longitudeDelta: dLon,
    });
  }, []);

  const plotAt = useCallback(
    async (lat: number, lon: number, kind: string) => {
      setBusy(true);
      setUserPos({ lat, lon });
      onUserLocation(lat, lon);
      setRoute(null);
      setHospName('—');
      setHospPhone('—');
      setHospDoctor('—');
      setHospRoute('—');
      setStatus('Loading nearby hospitals…');
      try {
        const rows = await fetchHospitalRows(lat, lon);
        setHospitals(rows);
        fitMap(lat, lon, rows);
        setStatus(
          rows.length
            ? `Found ${rows.length} hospital/clinic marker${rows.length === 1 ? '' : 's'} nearby. Tap pins for names.`
            : 'No hospitals found in this area via search. Use Open in Maps or zoom out.',
        );
        onLog(`SOS: ${rows.length} hospital(s) plotted (${kind}).`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Network error.';
        setStatus(`Hospital lookup failed: ${msg}`);
        onLog(`SOS: hospital lookup failed — ${msg}`);
      } finally {
        setBusy(false);
      }
    },
    [fitMap, onLog, onUserLocation],
  );

  const refreshGps = useCallback(async () => {
    setBusy(true);
    setHospitals([]);
    setRoute(null);
    setStatus('Locating you…');
    const { status: perm } = await Location.requestForegroundPermissionsAsync();
    if (perm !== 'granted') {
      setStatus('Location permission denied. Use Approx. from IP or Search map.');
      setBusy(false);
      return;
    }
    try {
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const lat = pos.coords.latitude;
      const lon = pos.coords.longitude;
      await plotAt(lat, lon, 'gps');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not get your location.';
      setStatus(msg);
      onLog(`SOS: ${msg}`);
    } finally {
      setBusy(false);
    }
  }, [onLog, plotAt]);

  const onOpen = useCallback(() => {
    setStatus('Getting your location…');
    void refreshGps();
  }, [refreshGps]);

  const onIp = useCallback(async () => {
    setBusy(true);
    setHospitals([]);
    setRoute(null);
    setStatus('Getting rough location from IP…');
    try {
      const { lat, lon } = await fetchApproxIpLocation();
      await plotAt(lat, lon, 'ip');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'IP location failed.';
      setStatus(msg);
    } finally {
      setBusy(false);
    }
  }, [plotAt]);

  const onSearchPlace = useCallback(async () => {
    setBusy(true);
    setHospitals([]);
    setRoute(null);
    setStatus('Finding that place…');
    try {
      const { lat, lon } = await geocodeWithPhoton(search);
      await plotAt(lat, lon, 'search');
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Search failed.';
      setStatus(msg);
    } finally {
      setBusy(false);
    }
  }, [plotAt, search]);

  const onSelectHospital = useCallback(
    async (row: HospitalRow) => {
      if (!userPos) {
        setHospRoute('Set your location first (Refresh / IP / Search).');
        return;
      }
      setHospName(row.name);
      setHospPhone('Loading…');
      setHospDoctor('Loading…');
      setHospRoute('Computing route…');
      try {
        const [routeRes, detailsRes] = await Promise.allSettled([
          sosDrawRouteMeta(userPos.lat, userPos.lon, row.lat, row.lon),
          fetchHospitalDetailsOverpass(row.lat, row.lon),
        ]);
        const r = routeRes.status === 'fulfilled' ? routeRes.value : null;
        const d = detailsRes.status === 'fulfilled' ? detailsRes.value : null;
        setHospPhone(d?.phone || 'Not listed');
        setHospDoctor(d?.doctor || 'Not listed');
        setHospRoute(r?.routeText || 'Route unavailable');
        setRoute(r?.coordinates || null);
        if (r?.coordinates?.length) {
          setRegion((prev) => ({
            ...prev,
            latitude: (userPos.lat + row.lat) / 2,
            longitude: (userPos.lon + row.lon) / 2,
            latitudeDelta: Math.max(0.05, Math.abs(userPos.lat - row.lat) * 2.5),
            longitudeDelta: Math.max(0.05, Math.abs(userPos.lon - row.lon) * 2.5),
          }));
        }
        setStatus('Route + hospital info loaded. Tap another pin to switch.');
        onLog(`SOS: Selected hospital "${row.name}".`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Error';
        setHospRoute('Route/details error: ' + msg);
      }
    },
    [onLog, userPos],
  );

  const openMaps = useCallback(() => {
    if (!userPos) return;
    const q = encodeURIComponent('hospital');
    const url = `https://www.google.com/maps/search/${q}/@${userPos.lat},${userPos.lon},14z`;
    void Linking.openURL(url);
  }, [userPos]);

  const clearRoute = useCallback(() => {
    setRoute(null);
    setHospName('—');
    setHospPhone('—');
    setHospDoctor('—');
    setHospRoute('—');
    setStatus('Route cleared. Tap a hospital pin again.');
  }, []);

  return (
    <Modal visible={visible} animationType="slide" onShow={onOpen}>
      <View style={styles.root}>
        <View style={styles.head}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>Emergency — nearby hospitals</Text>
            <Text style={styles.sub}>{status}</Text>
          </View>
          {busy ? <ActivityIndicator color={colors.cyan400} style={{ marginRight: 8 }} /> : null}
          <Pressable onPress={openMaps} style={styles.btnDanger}>
            <Text style={styles.btnDangerText}>Open in Maps</Text>
          </Pressable>
          <Pressable onPress={refreshGps} style={styles.btn}>
            <Text style={styles.btnText}>Refresh</Text>
          </Pressable>
          <Pressable onPress={onClose} style={styles.btn}>
            <Text style={styles.btnText}>Close</Text>
          </Pressable>
        </View>

        <View style={styles.tools}>
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="City, address, or landmark…"
            placeholderTextColor={colors.slate400}
            style={styles.input}
            onSubmitEditing={() => void onSearchPlace()}
          />
          <Pressable onPress={() => void onSearchPlace()} style={styles.btn}>
            <Text style={styles.btnText}>Search</Text>
          </Pressable>
          <Pressable onPress={() => void onIp()} style={styles.btn}>
            <Text style={styles.btnText}>Approx. IP</Text>
          </Pressable>
        </View>

        <MapView style={styles.map} region={region} onRegionChangeComplete={setRegion}>
          {userPos ? (
            <>
              <Circle
                center={{ latitude: userPos.lat, longitude: userPos.lon }}
                radius={90}
                strokeColor="rgba(56,189,248,0.9)"
                fillColor="rgba(34,211,238,0.18)"
              />
              <Marker coordinate={{ latitude: userPos.lat, longitude: userPos.lon }} title="You" />
            </>
          ) : null}
          {hospitals.map((h, i) => (
            <Marker
              key={`${h.lat}-${h.lon}-${i}`}
              coordinate={{ latitude: h.lat, longitude: h.lon }}
              title={h.name}
              description={h.addr}
              onCalloutPress={() => void onSelectHospital(h)}
              onPress={() => void onSelectHospital(h)}
            />
          ))}
          {route && route.length > 1 ? (
            <Polyline
              coordinates={route}
              strokeColor="rgba(251,113,133,0.85)"
              strokeWidth={4}
            />
          ) : null}
        </MapView>

        <ScrollView style={styles.details} keyboardShouldPersistTaps="handled">
          <View style={styles.detailsHead}>
            <View>
              <Text style={styles.detailsTitle}>Hospital info</Text>
              <Text style={styles.detailsHint}>Tap a hospital pin for route + contact details.</Text>
            </View>
            <Pressable onPress={clearRoute} style={styles.btn}>
              <Text style={styles.btnText}>Clear route</Text>
            </Pressable>
          </View>
          <Row label="Name" value={hospName} />
          <Row label="Phone" value={hospPhone} />
          <Row label="Doctor" value={hospDoctor} />
          <Row label="Route" value={hospRoute} />
          <Text style={styles.foot}>
            Map data: OpenStreetMap contributors. Hospitals: Photon search (Overpass fallback). For emergencies call
            your local emergency number.
          </Text>
        </ScrollView>
      </View>
    </Modal>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowK}>{label}</Text>
      <Text style={styles.rowV}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ink950 },
  head: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  title: { color: colors.slate100, fontSize: 16, fontWeight: '600' },
  sub: { color: colors.slate400, fontSize: 12, marginTop: 4 },
  tools: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    padding: 10,
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.25)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  input: {
    flex: 1,
    minWidth: 160,
    minHeight: 44,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    paddingHorizontal: 12,
    color: colors.slate100,
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  map: { flex: 1, minHeight: 280 },
  details: {
    maxHeight: 220,
    paddingHorizontal: 14,
    paddingBottom: 12,
    backgroundColor: 'rgba(0,0,0,0.2)',
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.06)',
  },
  detailsHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginTop: 10 },
  detailsTitle: { color: colors.slate100, fontSize: 15, fontWeight: '600' },
  detailsHint: { color: colors.slate400, fontSize: 11, marginTop: 4 },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, marginTop: 8 },
  rowK: { color: colors.slate400, fontSize: 13 },
  rowV: { flex: 1, textAlign: 'right', color: colors.slate100, fontFamily: 'monospace', fontSize: 12 },
  foot: { color: colors.slate400, fontSize: 10, marginTop: 12, lineHeight: 14 },
  btn: {
    paddingHorizontal: 12,
    height: 40,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    backgroundColor: 'rgba(255,255,255,0.05)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnText: { color: colors.slate100, fontSize: 12, fontWeight: '600' },
  btnDanger: {
    paddingHorizontal: 12,
    height: 40,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(244,63,94,0.45)',
    backgroundColor: 'rgba(244,63,94,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnDangerText: { color: colors.rose200, fontSize: 12, fontWeight: '600' },
});
