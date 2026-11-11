'use strict';

/* =========================================================
 * 택시미터 PWA
 * - 요금: 시간·거리 병산제 (서울 중형택시 기준 기본값)
 *   저속(기준 속도 미만)·정차 중에는 시간을, 그 이상에서는 거리를 센다.
 *   시간 1단위(30초)는 거리 1단위(131m)로 환산해 같은 계산에 합친다.
 * ========================================================= */

const DEFAULTS = {
  baseFare: 4800,   // 기본요금 (원)
  baseDist: 1600,   // 기본거리 (m)
  unitFare: 100,    // 추가요금 단위 (원)
  unitDist: 131,    // 거리 단위 (m)
  unitTime: 30,     // 시간 단위 (초)
  slowKmh: 15.72,   // 이 속도 미만이면 시간요금
  manualRate: 20,   // 할증 버튼 할증률 (%)
  nightAuto: true,  // 심야 할증 자동
  simulate: false,  // 시뮬레이션 모드
  simSpeed: 1,      // 시뮬레이션 배속
};

const GPS_MAX_ACCURACY = 40;   // 이보다 부정확한 위치는 버림 (m)
const GPS_STALE_MS = 10000;    // 이 시간 동안 위치가 없으면 "GPS 약함"
const MAX_SPEED_MS = 70;       // 이보다 빠른 이동은 튐으로 보고 버림 (m/s, 252km/h)
const HISTORY_LIMIT = 300;

const $ = (s) => document.querySelector(s);
const won = (n) => Math.round(n).toLocaleString('ko-KR');

/* ---------- 저장소 (실패해도 앱은 동작) ---------- */
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 무시 */ }
  },
};

let settings = { ...DEFAULTS, ...store.get('tm.settings', {}) };
let trip = store.get('tm.trip', null);        // 진행 중인 운행
let lastTrip = store.get('tm.last', null);    // 마지막으로 끝난 운행
let history = store.get('tm.history', []);
let manualOn = store.get('tm.manual', false);

const saveTrip = () => store.set('tm.trip', trip);

/* ---------- 할증 ---------- */
function nightRate(date) {
  if (!settings.nightAuto) return 0;
  const h = date.getHours();
  if (h >= 23 || h < 2) return 40;
  if (h === 22 || (h >= 2 && h < 4)) return 20;
  return 0;
}
const currentRate = (date = new Date()) => nightRate(date) + (manualOn ? settings.manualRate : 0);

/* ---------- 요금 계산 ---------- */
function newTrip() {
  const now = Date.now();
  const rate = currentRate();
  const base = settings.baseFare;
  return {
    id: now,
    start: now,
    end: null,
    sim: !!settings.simulate,
    lastTick: now,
    moved: 0,          // 실제 이동 거리 (표시용, m)
    elapsed: 0,        // 운행 시간 (초, 시뮬레이션 배속 반영)
    slowSec: 0,        // 저속·정차 시간 (초)
    effDist: 0,        // 요금 계산용 환산 거리 (m)
    units: 0,          // 기본거리 이후 지난 단위 수
    baseRaw: base,
    distRaw: 0,
    timeRaw: 0,
    extra: Math.round(base * rate / 100),
    maxRate: rate,
  };
}

const fareOf = (t) => t.baseRaw + t.distRaw + t.timeRaw + t.extra;

// kind: 'd' 거리, 't' 시간
function addEffective(meters, kind) {
  if (!trip || meters <= 0) return;
  trip.effDist += meters;
  const units = Math.max(0, Math.floor((trip.effDist - settings.baseDist) / settings.unitDist));
  if (units <= trip.units) return;
  const rate = currentRate();
  trip.maxRate = Math.max(trip.maxRate, rate);
  const n = units - trip.units;
  const raw = n * settings.unitFare;
  if (kind === 'd') trip.distRaw += raw; else trip.timeRaw += raw;
  trip.extra += Math.round(raw * rate / 100);
  trip.units = units;
}

/* ---------- GPS ---------- */
const gps = {
  watchId: null,
  simTimer: null,
  anchor: null,      // 마지막 기준 위치 {lat, lon, t}
  speed: 0,          // m/s
  speedAt: 0,
  acc: null,
  lastFix: 0,
  denied: false,
};

function haversine(a, b) {
  const R = 6371000;
  const toRad = (d) => d * Math.PI / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const x = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

function onPosition(pos) {
  const c = pos.coords;
  const now = Date.now();
  gps.acc = c.accuracy;
  gps.lastFix = now;
  gps.denied = false;
  if (c.accuracy > GPS_MAX_ACCURACY) return;

  const point = { lat: c.latitude, lon: c.longitude, t: pos.timestamp || now };
  if (!gps.anchor) { gps.anchor = point; return; }

  const dt = (point.t - gps.anchor.t) / 1000;
  if (dt <= 0) return;
  const d = haversine(gps.anchor, point);

  // 정확도 범위 안의 작은 움직임은 제자리 흔들림으로 본다
  if (d < Math.max(5, c.accuracy * 0.5)) {
    if (dt > 5) { gps.speed = 0; gps.speedAt = now; }
    return;
  }

  const speed = d / dt;
  if (speed > MAX_SPEED_MS) { gps.anchor = point; return; }

  gps.speed = speed;
  gps.speedAt = now;
  gps.anchor = point;

  if (trip) {
    trip.moved += d;
    if (speed * 3.6 >= settings.slowKmh) addEffective(d, 'd');
    saveTrip();
  }
}

function onPositionError(err) {
  if (err.code === err.PERMISSION_DENIED) {
    gps.denied = true;
    toast('위치 권한이 필요합니다. 브라우저 설정에서 허용해 주세요.');
  }
}

function startGps() {
  stopGps();
  gps.anchor = null;
  if (settings.simulate) { startSimulation(); return; }
  if (!('geolocation' in navigator)) { toast('이 기기는 GPS를 지원하지 않습니다.'); return; }
  gps.watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 15000,
  });
}

function stopGps() {
  if (gps.watchId !== null) navigator.geolocation.clearWatch(gps.watchId);
  if (gps.simTimer) clearInterval(gps.simTimer);
  gps.watchId = null;
  gps.simTimer = null;
  gps.lastFix = 0;
  gps.speed = 0;
}

/* ---------- 시뮬레이션: 정차 → 가속 → 정속 → 저속 반복 ---------- */
const SIM_PATTERN = [[10, 0], [8, 20], [40, 45], [15, 10], [20, 0], [30, 60], [20, 12]]; // [초, km/h]
function startSimulation() {
  const sim = { lat: 37.5665, lon: 126.978, clock: Date.now(), elapsed: 0 };
  const cycle = SIM_PATTERN.reduce((s, [sec]) => s + sec, 0);
  gps.simTimer = setInterval(() => {
    const step = settings.simSpeed;
    sim.elapsed += step;
    sim.clock += step * 1000;
    let t = sim.elapsed % cycle;
    let kmh = 0;
    for (const [sec, v] of SIM_PATTERN) { if (t < sec) { kmh = v; break; } t -= sec; }
    const meters = (kmh / 3.6) * step;
    sim.lat += (meters * 0.7) / 111320;
    sim.lon += (meters * 0.7) / (111320 * Math.cos(sim.lat * Math.PI / 180));
    onPosition({
      coords: { latitude: sim.lat, longitude: sim.lon, accuracy: 5, speed: kmh / 3.6 },
      timestamp: sim.clock,
    });
  }, 1000);
}

/* ---------- 화면 꺼짐 방지 ---------- */
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* 지원하지 않거나 거부됨 */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && trip) keepAwake(true);
});
document.addEventListener('pointerdown', () => { if (trip && !wakeLock) keepAwake(true); });

/* ---------- 상태 판단 ---------- */
function gpsState() {
  if (gps.denied) return 'denied';
  if (gps.watchId === null && !gps.simTimer) return 'off';
  if (!gps.lastFix || Date.now() - gps.lastFix > GPS_STALE_MS || gps.acc > GPS_MAX_ACCURACY) return 'weak';
  return 'ok';
}
function speedKmh() {
  return Date.now() - gps.speedAt < 8000 ? gps.speed * 3.6 : 0;
}

/* ---------- 1초 타이머: 시간요금, 화면 갱신 ---------- */
function tick() {
  const now = Date.now();
  if (trip) {
    let dt = (now - trip.lastTick) / 1000;
    dt = Math.min(Math.max(dt, 0), 5);          // 잠깐 멈췄던 시간은 최대 5초만 인정
    if (trip.sim) dt *= settings.simSpeed;
    trip.lastTick = now;
    trip.elapsed += dt;
    if (speedKmh() < settings.slowKmh) {
      trip.slowSec += dt;
      addEffective(dt * settings.unitDist / settings.unitTime, 't');
    }
    saveTrip();
  }
  render();
}

/* ---------- 화면 ---------- */
const DAYS = ['일', '월', '화', '수', '목', '금', '토'];
const pad = (n) => String(n).padStart(2, '0');
const fmtClock = (d) => `${d.getMonth() + 1}/${d.getDate()}[${DAYS[d.getDay()]}] ${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fmtTime = (ms) => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtKm = (m) => `${(m / 1000).toFixed(2)} km`;
function fmtDuration(sec) {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  return h ? `${h}시간 ${m}분 ${s}초` : `${m}분 ${s}초`;
}
const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const todayTrips = () => history.filter((t) => sameDay(new Date(t.start), new Date()));

let endConfirmAt = 0;

function setCell(el, lbl, sub, cls) {
  el.querySelector('.lbl').textContent = lbl;
  el.querySelector('.sub').textContent = sub;
  el.className = 'cell' + (cls ? ' ' + cls : '');
}

function render() {
  const now = new Date();
  $('#clock').textContent = fmtClock(now);

  const today = todayTrips();
  $('#daily').textContent = won(today.reduce((s, t) => s + fareOf(t), 0));
  $('#count').textContent = `${today.length}건`;

  const gs = gpsState();
  const gpsEl = $('#gps');
  const gpsText = {
    off: 'GPS 꺼짐',
    denied: 'GPS 거부',
    weak: 'GPS 약함',
    ok: settings.simulate ? 'GPS 시뮬' : `GPS ±${Math.round(gps.acc)}m`,
  }[gs];
  gpsEl.textContent = gpsText;
  gpsEl.className = 'gps ' + (gs === 'ok' ? 'ok' : gs === 'off' ? 'off' : 'weak');

  const shown = trip || lastTrip;
  $('#fare').textContent = shown ? won(fareOf(shown)) : '0';
  $('#dist').textContent = fmtKm(shown ? shown.moved : 0);

  const rate = currentRate(now);
  $('#rate').textContent = rate ? `+${rate}%` : '';

  // 운행 시작/종료 칸
  const run = $('#btnRun');
  if (!trip) setCell(run, '빈차', '눌러서 운행 시작', '');
  else if (Date.now() - endConfirmAt < 3000) setCell(run, '종료?', '한 번 더 누르면 종료', 'confirm');
  else setCell(run, '운행', '눌러서 운행 종료', 'on');

  // 할증 칸
  const sur = $('#btnSur');
  setCell(sur, '할증', manualOn ? `켜짐 +${settings.manualRate}%` : '꺼짐', manualOn ? 'on' : '');
  sur.setAttribute('aria-pressed', String(manualOn));

  // 주행 상태 칸
  const drive = $('#cellDrive');
  if (!trip) setCell(drive, '대기', '미터 꺼짐', '');
  else if (gs !== 'ok') setCell(drive, '주행', 'GPS 약함 · 시간요금', 'weak');
  else {
    const v = speedKmh();
    if (v >= settings.slowKmh) setCell(drive, '주행', `${Math.round(v)} km/h · 거리요금`, 'driving');
    else setCell(drive, '주행', `저속 ${Math.round(v)} km/h · 시간요금`, 'slow');
  }
}

/* ---------- 운행 시작 / 종료 ---------- */
function startTrip() {
  trip = newTrip();
  lastTrip = null;
  store.set('tm.last', null);
  saveTrip();
  startGps();
  keepAwake(true);
  toast(settings.simulate ? '운행 시작 (시뮬레이션)' : '운행 시작');
}

function endTrip() {
  trip.end = Date.now();
  delete trip.lastTick;
  history.unshift(trip);
  if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT;
  lastTrip = trip;
  trip = null;
  endConfirmAt = 0;
  store.set('tm.history', history);
  store.set('tm.last', lastTrip);
  saveTrip();
  stopGps();
  keepAwake(false);
  toast(`운행 종료 · ${won(fareOf(lastTrip))}원`);
}

$('#btnRun').addEventListener('click', () => {
  if (!trip) startTrip();
  else if (Date.now() - endConfirmAt < 3000) endTrip();
  else endConfirmAt = Date.now();
  render();
});

$('#btnSur').addEventListener('click', () => {
  manualOn = !manualOn;
  store.set('tm.manual', manualOn);
  render();
});

$('#btnPay').addEventListener('click', () => {
  if (trip) showReceipt({ ...trip, end: Date.now() }, true);
  else if (lastTrip) showReceipt(lastTrip, false);
  else toast('발행할 운행이 없습니다.');
});

/* ---------- 영수증 ---------- */
let receiptText = '';

function showReceipt(t, interim) {
  const durationSec = t.elapsed ?? (t.end - t.start) / 1000;
  const rows = [
    ['승차', fmtTime(t.start)],
    [interim ? '정산 시각' : '하차', fmtTime(t.end)],
    ['소요 시간', fmtDuration(durationSec)],
    ['이동 거리', fmtKm(t.moved)],
    ['저속·정차', fmtDuration(t.slowSec)],
  ];
  const money = [
    ['기본요금', t.baseRaw],
    ['거리요금', t.distRaw],
    ['시간요금', t.timeRaw],
    [`할증요금${t.maxRate ? ` (최대 ${t.maxRate}%)` : ''}`, t.extra],
  ];
  const total = fareOf(t);
  const row = ([k, v]) => `<div class="row"><span>${k}</span><span>${v}</span></div>`;

  $('#receipt').innerHTML = `
    <h3>택시 영수증</h3>
    ${interim ? '<div class="tag">중간 정산 · 미터 운행 중</div>' : ''}
    ${t.sim ? '<div class="tag">시뮬레이션 운행</div>' : ''}
    <hr>
    ${rows.map(row).join('')}
    <hr>
    ${money.map(([k, v]) => row([k, `${won(v)}원`])).join('')}
    <hr>
    <div class="row total"><span>합계</span><span>${won(total)}원</span></div>
    <div class="foot">발행 ${fmtTime(Date.now())} · No.${t.id}</div>`;

  receiptText = [
    '[택시 영수증]' + (interim ? ' (중간 정산)' : ''),
    ...rows.map(([k, v]) => `${k}: ${v}`),
    ...money.map(([k, v]) => `${k}: ${won(v)}원`),
    `합계: ${won(total)}원`,
  ].join('\n');

  openModal('#receiptModal');
}

$('#receiptModal').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'print') window.print();
  if (act === 'share') {
    try {
      if (navigator.share) await navigator.share({ title: '택시 영수증', text: receiptText });
      else { await navigator.clipboard.writeText(receiptText); toast('영수증을 복사했습니다.'); }
    } catch (err) {
      if (err && err.name !== 'AbortError') toast('공유하지 못했습니다.');
    }
  }
});

/* ---------- 운행 기록 ---------- */
function showHistory() {
  const list = $('#historyList');
  const today = todayTrips();
  list.innerHTML = today.length ? '' : '<li class="empty">오늘 끝난 운행이 없습니다.</li>';
  for (const t of today) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.innerHTML = `<span>${fmtTime(t.start)} · ${fmtKm(t.moved)}${t.sim ? ' · 시뮬' : ''}</span><b>${won(fareOf(t))}원</b>`;
    b.addEventListener('click', () => { closeModals(); showReceipt(t, false); });
    li.append(b);
    list.append(li);
  }
  openModal('#historyModal');
}
$('#keyHistory').addEventListener('click', showHistory);

/* ---------- 설정 (가운데 버튼 길게 누르기) ---------- */
const form = $('#settingsForm');

function fillSettings(s) {
  for (const [k, v] of Object.entries(s)) {
    const input = form.elements[k];
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = !!v; else input.value = v;
  }
}

function showSettings() {
  fillSettings(settings);
  openModal('#settingsModal');
}

let pressTimer = null;
const key = $('#keySettings');
key.addEventListener('pointerdown', () => {
  pressTimer = setTimeout(() => { pressTimer = null; showSettings(); }, 700);
});
['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => key.addEventListener(ev, () => {
  if (pressTimer) {
    clearTimeout(pressTimer);
    pressTimer = null;
    if (ev === 'pointerup') toast('길게 누르면 설정이 열립니다.');
  }
}));
key.addEventListener('contextmenu', (e) => e.preventDefault());
key.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showSettings(); } });

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const prevSim = settings.simulate;
  const next = { ...settings };
  for (const k of Object.keys(DEFAULTS)) {
    const input = form.elements[k];
    if (!input) continue;
    next[k] = input.type === 'checkbox' ? input.checked : Number(input.value);
  }
  settings = next;
  store.set('tm.settings', settings);
  if (trip && prevSim !== settings.simulate) {
    trip.sim = trip.sim || settings.simulate;
    startGps();
  }
  closeModals();
  toast('설정을 저장했습니다.');
  render();
});

$('#btnDefaults').addEventListener('click', () => fillSettings(DEFAULTS));

$('#btnResetToday').addEventListener('click', () => {
  if (!confirm('오늘 운행 기록과 일합산을 지울까요?')) return;
  const now = new Date();
  history = history.filter((t) => !sameDay(new Date(t.start), now));
  store.set('tm.history', history);
  if (lastTrip && sameDay(new Date(lastTrip.start), now)) { lastTrip = null; store.set('tm.last', null); }
  toast('오늘 기록을 지웠습니다.');
  render();
});

/* ---------- 모달 / 토스트 ---------- */
function openModal(sel) {
  closeModals();
  $(sel).hidden = false;
}
function closeModals() {
  document.querySelectorAll('.modal').forEach((m) => { m.hidden = true; });
}
document.querySelectorAll('.modal').forEach((m) => {
  m.addEventListener('click', (e) => {
    if (e.target === m || e.target.closest('[data-close]')) closeModals();
  });
});
$('#keyBack').addEventListener('click', closeModals);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModals(); });

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2500);
}

/* ---------- 시작 ---------- */
if (trip) {
  // 새로고침 등으로 다시 열렸을 때 진행 중인 운행을 이어서 계산
  trip.lastTick = Date.now();
  startGps();
  keepAwake(true);
  toast('진행 중인 운행을 이어서 계산합니다.');
}
render();
setInterval(tick, 1000);
