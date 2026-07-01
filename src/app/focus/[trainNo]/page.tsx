'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import * as turf from '@turf/turf';

interface Station { name: string; lat: number; lng: number; corridor_dist_m: number }
interface TrainStop { station: string; arrival: string | null; departure: string | null }
interface TrainRun {
  train_no: string; name: string; type: string; color: string;
  service_path_id: string; stops: TrainStop[];
}
interface CorridorData {
  corridor: {
    geometry: { type: string; coordinates: number[][] };
    stations: Station[];
  };
  train_runs: TrainRun[];
}

/* ---- 사다리꼴 속도 프로파일 ---- */
interface SegProfile {
  accelDist: number; cruiseDist: number; decelDist: number;
  accelTime: number; cruiseTime: number; decelTime: number;
  v: number; a: number; totalDist: number; totalTime: number;
}

function computeProfile(D: number, T: number, maxV: number, accel: number): SegProfile {
  // 이분탐색으로 v 찾기
  let lo = 1, hi = maxV;
  for (let iter = 0; iter < 50; iter++) {
    const v = (lo + hi) / 2;
    const accelTime = v / accel;
    const accelDist = v * v / (2 * accel);
    const cruiseDist = D - 2 * accelDist;
    if (cruiseDist < 0) { hi = v; continue; }
    const cruiseTime = cruiseDist / v;
    const totalTime = 2 * accelTime + cruiseTime;
    if (totalTime > T) hi = v; else lo = v;
  }
  let v = (lo + hi) / 2;
  if (v > maxV) v = maxV;

  let accelTime = v / accel;
  let accelDist = v * v / (2 * accel);
  let cruiseDist = D - 2 * accelDist;

  // 삼각형 프로파일 (cruiseDist < 0)
  if (cruiseDist < 0) {
    v = Math.sqrt(accel * D);
    if (v > maxV) v = maxV;
    accelTime = v / accel;
    accelDist = v * v / (2 * accel);
    cruiseDist = 0;
    const decelTime = v / accel;
    return { accelDist, cruiseDist: 0, decelDist: accelDist, accelTime, cruiseTime: 0, decelTime, v, a: accel, totalDist: D, totalTime: 2 * accelTime };
  }

  const cruiseTime = cruiseDist / v;
  const decelTime = v / accel;
  const totalTime = 2 * accelTime + cruiseTime;
  return { accelDist, cruiseDist, decelDist: accelDist, accelTime, cruiseTime, decelTime, v, a: accel, totalDist: D, totalTime };
}

function posAtTime(profile: SegProfile, elapsed: number): number {
  if (elapsed <= 0) return 0;
  if (elapsed >= profile.totalTime) return profile.totalDist;

  const { accelDist, cruiseDist, decelDist, accelTime, cruiseTime, decelTime, v, a } = profile;
  if (elapsed < accelTime) return 0.5 * a * elapsed * elapsed;
  const t1 = elapsed - accelTime;
  if (t1 < cruiseTime) return accelDist + v * t1;
  const t2 = t1 - cruiseTime;
  return accelDist + cruiseDist + v * t2 - 0.5 * a * t2 * t2;
}

/* ---- 메인 컴포넌트 ---- */
export default function FocusPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const trainNo = params.trainNo as string;
  const fromName = searchParams.get('from') || '서울';
  const toName = searchParams.get('to') || '부산';

  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const animRef = useRef<number>(0);

  const [data, setData] = useState<CorridorData | null>(null);
  const [train, setTrain] = useState<TrainRun | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(5);
  const [progress, setProgress] = useState(0); // 0~1
  const [currentStation, setCurrentStation] = useState(fromName);
  const [nextStation, setNextStation] = useState('');
  const [currentTime, setCurrentTime] = useState('');
  const [arrivalTime, setArrivalTime] = useState('');
  const [elapsedSec, setElapsedSec] = useState(0);
  const [totalSec, setTotalSec] = useState(0);
  const [markerEl, setMarkerEl] = useState<HTMLDivElement | null>(null);

  // 데이터 로드
  useEffect(() => {
    fetch('/data/gyeongbu-corridor.json').then(r => r.json()).then((d: CorridorData) => {
      setData(d);
      const t = d.train_runs.find(r => r.train_no === trainNo);
      if (t) setTrain(t);
    });
  }, [trainNo]);

  // 출발/도착 인덱스
  const fromIdx = data && train ? train.stops.findIndex(s => s.station === fromName) : -1;
  const toIdx = data && train ? train.stops.findIndex(s => s.station === toName) : -1;

  // 총 소요시간 계산
  useEffect(() => {
    if (!train || fromIdx < 0 || toIdx < 0) return;
    const dep = train.stops[fromIdx].departure;
    const arr = train.stops[toIdx].arrival;
    if (!dep || !arr) return;
    const [h1, m1] = dep.split(':').map(Number);
    const [h2, m2] = arr.split(':').map(Number);
    setTotalSec((h2 * 60 + m2) - (h1 * 60 + m1) * 60);
    setArrivalTime(arr);
  }, [train, fromIdx, toIdx]);

  // 초기화
  const initRef = useRef(false);

  // MapLibre 초기화
  useEffect(() => {
    if (!data || !train || !mapContainer.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
      center: [128.0, 36.3],
      zoom: 7,
      attributionControl: false,
    });

    map.on('load', () => {
      const coords = data.corridor.geometry.coordinates as [number, number][];

      // 전체 corridor
      map.addSource('corridor', {
        type: 'geojson',
        data: { type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} }
      });
      map.addLayer({
        id: 'corridor-line',
        type: 'line', source: 'corridor',
        paint: { 'line-color': '#93c5fd', 'line-width': 3 }
      });

      // 역 마커
      data.corridor.stations.forEach(s => {
        const el = document.createElement('div');
        el.className = 'w-2 h-2 rounded-full bg-gray-400 border border-white';
        new maplibregl.Marker({ element: el })
          .setLngLat([s.lng, s.lat])
          .addTo(map);
      });

      // 열차 마커
      const markerDiv = document.createElement('div');
      markerDiv.className = 'w-5 h-5 rounded-full border-2 border-white shadow-md';
      markerDiv.style.backgroundColor = train.color;
      markerDiv.style.boxShadow = '0 0 8px rgba(0,0,0,0.3)';
      setMarkerEl(markerDiv);

      const startCoord = coords[0];
      new maplibregl.Marker({ element: markerDiv })
        .setLngLat([startCoord[0], startCoord[1]])
        .addTo(map);

      mapRef.current = map;
      initRef.current = true;
    });

    return () => { map.remove(); mapRef.current = null; };
  }, [data, train]);

  // 재생 로직
  useEffect(() => {
    if (!playing || !data || !train || fromIdx < 0 || toIdx < 0 || totalSec <= 0) return;

    const coords = data.corridor.geometry.coordinates as [number, number][];
    const line = turf.lineString(coords);

    // 구간별 profile 계산
    const segments: { fromDist: number; toDist: number; profile: SegProfile }[] = [];
    let currentDist = 0;

    for (let i = fromIdx; i < toIdx; i++) {
      const stop = train.stops[i];
      const nextStop = train.stops[i + 1];
      if (!stop.departure || !nextStop.arrival) continue;

      const depTime = stop.departure.split(':').map(Number);
      const arrTime = nextStop.arrival.split(':').map(Number);
      const segTimeSec = ((arrTime[0] * 60 + arrTime[1]) - (depTime[0] * 60 + depTime[1])) * 60;
      if (segTimeSec <= 0) continue;

      const fromS = data.corridor.stations.find(s => s.name === stop.station);
      const toS = data.corridor.stations.find(s => s.name === nextStop.station);
      if (!fromS || !toS) continue;

      const segDist = toS.corridor_dist_m - fromS.corridor_dist_m;
      if (segDist <= 0) continue;

      const maxV = train.type === 'KTX' ? 85 : 40; // m/s
      const accel = train.type === 'KTX' ? 0.3 : 0.4;
      const profile = computeProfile(segDist, segTimeSec, maxV, accel);

      segments.push({
        fromDist: fromS.corridor_dist_m,
        toDist: toS.corridor_dist_m,
        profile
      });
    }

    if (segments.length === 0) return;

    const startTime = Date.now();
    let totalSegTime = segments.reduce((s, seg) => s + seg.profile.totalTime * 1000, 0);
    totalSegTime /= speed;

    // 구간별 elapsed offset
    const segOffsets: number[] = [0];
    for (let i = 0; i < segments.length; i++) {
      segOffsets.push(segOffsets[i] + segments[i].profile.totalTime * 1000 / speed);
    }

    const marker = document.querySelector('.maplibregl-marker') as HTMLElement;
    animRef.current = requestAnimationFrame(function animate() {
      const now = Date.now();
      const elapsed = (now - startTime) / 1000 * speed; // seconds in simulation time

      if (elapsed >= segments[segments.length - 1].profile.totalTime) {
        // 도착
        const endCoord = turf.along(line, segments[segments.length - 1].toDist, { units: 'meters' });
        if (marker) {
          marker.style.transform = `translate(-50%, -50%) translate(${endCoord.geometry.coordinates[0]}px, ${endCoord.geometry.coordinates[1]}px)`;
        }
        setProgress(1);
        setCurrentStation(toName);
        setNextStation('');
        setElapsedSec(totalSec);
        setPlaying(false);
        return;
      }

      // 현재 구간 찾기
      let segIdx = 0;
      let segElapsed = elapsed;
      for (let i = 0; i < segments.length; i++) {
        if (elapsed <= segments[i].profile.totalTime) { segIdx = i; break; }
        segElapsed -= segments[i].profile.totalTime;
      }
      if (segIdx >= segments.length) segIdx = segments.length - 1;

      const seg = segments[segIdx];
      const dist = seg.fromDist + posAtTime(seg.profile, Math.max(0, Math.min(segElapsed, seg.profile.totalTime)));

      const pt = turf.along(line, dist, { units: 'meters' });
      const [lng, lat] = pt.geometry.coordinates;

      // MapLibre marker 이동
      // Create new marker at position
      if (markerEl && mapRef.current) {
        // Remove old marker elements
        document.querySelectorAll('.train-marker').forEach(el => el.remove());
        const newMarker = document.createElement('div');
        newMarker.className = `train-marker w-5 h-5 rounded-full border-2 border-white shadow-md`;
        newMarker.style.backgroundColor = train.color;
        newMarker.style.boxShadow = '0 0 8px rgba(0,0,0,0.3)';
        new maplibregl.Marker({ element: newMarker })
          .setLngLat([lng, lat])
          .addTo(mapRef.current!);
      }

      // 카메라 따라가기
      if (mapRef.current) {
        mapRef.current.panTo([lng, lat], { duration: 0, animate: false });
      }

      // 진행률
      const totalSimTime = segments.reduce((s, seg) => s + seg.profile.totalTime, 0);
      const prog = Math.min(1, elapsed / totalSimTime);
      setProgress(prog);

      // 현재/다음역
      let cur = fromIdx;
      let nxt = fromIdx + 1;
      let el = 0;
      for (let i = 0; i < segments.length; i++) {
        if (el + segments[i].profile.totalTime >= elapsed) {
          cur = fromIdx + i;
          nxt = cur + 1;
          break;
        }
        el += segments[i].profile.totalTime;
      }
      if (cur < train.stops.length) setCurrentStation(train.stops[cur].station);
      if (nxt < train.stops.length) setNextStation(train.stops[nxt].station);

      // 남은 시간
      const remSec = Math.max(0, totalSec - elapsed);
      setElapsedSec(elapsed);

      animRef.current = requestAnimationFrame(animate);
    });

    return () => { if (animRef.current) cancelAnimationFrame(animRef.current); };
  }, [playing, data, train, fromIdx, toIdx, totalSec, speed]);

  const togglePlay = () => setPlaying(p => !p);
  const reset = () => { setPlaying(false); setProgress(0); setElapsedSec(0); setCurrentStation(fromName); };

  const formatTime = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}분 ${s}초`;
  };

  if (!data || !train) return (
    <div className="w-full h-screen flex items-center justify-center bg-gray-50">
      <div className="text-gray-400 text-sm">로딩 중...</div>
    </div>
  );

  return (
    <div className="w-full h-screen relative bg-gray-900 overflow-hidden">
      {/* 지도 */}
      <div ref={mapContainer} className="w-full h-full" />

      {/* 진행 정보 카드 */}
      <div className="absolute top-4 left-4 right-4 md:left-4 md:right-auto md:w-80 bg-white/95 backdrop-blur-sm rounded-xl shadow-lg p-4 z-10">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold px-2 py-0.5 rounded-full text-white" style={{ backgroundColor: train.color }}>
              {train.type}
            </span>
            <span className="text-sm font-semibold">{train.name}</span>
          </div>
          <span className="text-xs text-gray-500">{fromName} → {toName}</span>
        </div>

        {/* 진행 바 */}
        <div className="w-full h-1.5 bg-gray-200 rounded-full overflow-hidden mb-3">
          <div className="h-full bg-blue-500 rounded-full transition-all duration-300" style={{ width: `${progress * 100}%` }} />
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <div className="text-xs text-gray-500">현재역</div>
            <div className="font-semibold text-gray-900">{currentStation}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500">다음역</div>
            <div className="font-semibold text-blue-600">{nextStation || '도착'}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500">경과</div>
            <div className="font-semibold text-gray-900">{formatTime(elapsedSec)}</div>
          </div>
          <div>
            <div className="text-xs text-gray-500">도착예정</div>
            <div className="font-semibold text-gray-900">{arrivalTime || '-'}</div>
          </div>
        </div>

        {/* 컨트롤 */}
        <div className="flex items-center justify-between mt-3 pt-3 border-t border-gray-100">
          <div className="flex items-center gap-2">
            <button onClick={reset}
              className="px-2.5 py-1.5 text-xs bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors">
              ⟲
            </button>
            <button onClick={togglePlay}
              className="px-4 py-1.5 text-xs font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors">
              {playing ? '⏸ 일시정지' : '▶ 재생'}
            </button>
          </div>
          <div className="flex items-center gap-1">
            {[1, 2, 5, 10].map(s => (
              <button key={s} onClick={() => setSpeed(s)}
                className={`px-2 py-1 text-xs rounded-lg transition-colors ${speed === s ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                {s}×
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 모바일용 역 리스트 */}
      <div className="absolute bottom-4 left-4 right-4 md:hidden bg-white/95 backdrop-blur-sm rounded-xl shadow-lg p-3 z-10 max-h-32 overflow-y-auto">
        <div className="text-xs text-gray-500 mb-1">경로</div>
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {train.stops.slice(fromIdx, toIdx + 1).map((s, i) => {
            const isPassed = i / (toIdx - fromIdx) <= progress;
            return (
              <div key={s.station} className={`flex-shrink-0 text-center px-2 py-1 rounded-lg text-xs
                ${isPassed ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'}`}>
                {s.station}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
