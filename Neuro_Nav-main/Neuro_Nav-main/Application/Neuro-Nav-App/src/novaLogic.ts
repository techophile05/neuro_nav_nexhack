import type { MetricsSnapshot } from './biosignal';
import { fmt } from './biosignal';
import { fetchHospitalRows } from './sosApi';

export function novaBuildSignalAnalysis(s: MetricsSnapshot) {
  const eegRmsDisp = fmt(s.eegRms * 100, 1);
  let ecgLine =
    s.ecgStatus === 'WAIT'
      ? 'ECG heart-rate estimate is still stabilizing (demo detector).'
      : `ECG trend reads about ${s.bpm} BPM (${s.ecgStatus} for this demo logic only).`;
  let emgLine = s.emgGate
    ? 'EMG envelope is above your gate threshold — the dashboard treats this as higher muscle drive / activation.'
    : 'EMG envelope is below the gate — low activation in this demo.';
  let eegLine = `EEG RMS proxy is ~${eegRmsDisp} (scaled units), band hint ${s.eegBand}, quality ${s.eegQuality}.`;
  if (s.eegQuality === 'NOISY') {
    eegLine +=
      ' If this were a live headset, check electrodes, contact quality, mains interference, and motion artifact.';
  }
  let cardio = '';
  if (s.ecgStatus === 'FAST') {
    cardio =
      '\nIf you have chest pain, severe shortness of breath, fainting, or stroke-like symptoms, use SOS and your local emergency number now.';
  }
  if (s.ecgStatus === 'SLOW') {
    cardio =
      '\nIf you feel faint, confused, or have chest pain with a very slow rate on a clinical monitor, seek urgent care — this UI cannot confirm rhythm.';
  }
  return (
    `${eegLine}\n${emgLine}\n${ecgLine}${cardio}\n\n` +
    `Intent mapping (demo only): EEG→${s.eegCmd}. Console: mode=${s.mode}, armed=${s.armed}, stream=${s.running ? 'running' : 'paused'}, demo=${s.demo}.\n\n` +
    'Reminder: Neuro Nav is a research / demo UI, not a licensed diagnostic device.'
  );
}

export function novaMedicationReply() {
  return (
    'Medication guidance:\n' +
    'I must not prescribe or recommend specific drugs or doses. That requires your full medical history, allergies, pregnancy status, kidney/liver function, and an up-to-date medication list.\n\n' +
    'What I can suggest safely:\n' +
    '• Take this dashboard snapshot and your symptoms to a clinician or pharmacist.\n' +
    '• Ask about interactions, side effects, deprescribing, and non-drug options.\n' +
    '• Do not start/stop/merge medicines based on a chatbot.\n\n' +
    'If symptoms are severe or sudden, use SOS / emergency services instead of waiting for chat advice.'
  );
}

let novaHospitalCache: { t: number; names: string[] } = { t: 0, names: [] };

export async function novaHospitalsReply(userLat: number | null, userLon: number | null) {
  const lat = userLat;
  const lon = userLon;
  if (lat == null || lon == null) {
    return (
      'Hospital finder:\n' +
      'Open SOS, then use Approx. from IP or Search map so we have coordinates. Ask me again for names, or use Open in Maps inside SOS.'
    );
  }
  const now = Date.now();
  if (novaHospitalCache.t && now - novaHospitalCache.t < 90000 && novaHospitalCache.names.length) {
    return (
      'From your last area lookup (cached ~90s), nearby hospital/clinic POIs include:\n• ' +
      novaHospitalCache.names.join('\n• ') +
      '\n\nOpen SOS to verify on the map and tap a pin for routing.'
    );
  }
  try {
    const rows = await fetchHospitalRows(lat, lon);
    const names = rows.slice(0, 8).map((r) => r.name);
    novaHospitalCache = { t: now, names };
    if (!names.length) {
      return 'No hospital POIs returned in this radius (OpenStreetMap coverage varies).\nTry SOS → Search map / zoom out / Open in Maps.';
    }
    return (
      'Nearby names from our OSM-backed search (verify before traveling):\n• ' +
      names.join('\n• ') +
      '\n\nUse SOS to open the live map, compare routes, and read the Hospital info panel after you tap a pin.'
    );
  } catch {
    return 'Hospital lookup failed (network). Use SOS and Open in Maps as a fallback.';
  }
}

export async function novaReply(
  userText: string,
  snapshot: MetricsSnapshot,
  userLat: number | null,
  userLon: number | null,
) {
  const raw = String(userText || '').trim();
  if (!raw) return 'Type a question or tap a quick chip.';
  const q = raw.toLowerCase();

  if (
    /\b(911|999|112|ambulanc|heart attack|cardiac arrest|stroke|unconscious|not breathing|can't breathe|cannot breathe|choking)\b/.test(
      q,
    )
  ) {
    return 'Emergency:\nIf you or someone else may be in immediate danger, call your local emergency number now and use SOS if you need directions.\nA chatbot cannot triage emergencies.';
  }

  if (/\b(hospital|clinic|er\b|emergency room|nearby|directions|urgent care)\b/.test(q)) {
    return await novaHospitalsReply(userLat, userLon);
  }

  if (/\b(drug|pill|medication|medicine|prescription|dose|tablet|insulin|antibioti|opioid|benzo|ssri)\b/.test(q)) {
    return novaMedicationReply();
  }

  if (
    /\b(eeg|emg|ecg|ekg|signal|bpm|heart|muscle|brain|cortex|spasm|seiz|tremor)\b/.test(q) ||
    /\b(analy|interpret|status|levels|telemetry)\b/.test(q)
  ) {
    return novaBuildSignalAnalysis(snapshot);
  }

  return `${novaBuildSignalAnalysis(snapshot)}\n\nTip: ask about "hospitals", "medications" (safety only), or "signals".`;
}
