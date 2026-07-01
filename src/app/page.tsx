'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';

interface CorridorData {
  meta: { stations_count: number; train_count: number; total_length_m: number };
  corridor: { stations: { name: string; lat: number; lng: number }[] };
  train_runs: {
    train_no: string; name: string; type: string; color: string;
    stops: { station: string; arrival: string | null; departure: string | null }[];
  }[];
}

export default function Home() {
  const [data, setData] = useState<CorridorData | null>(null);
  const [from, setFrom] = useState('서울');
  const [to, setTo] = useState('부산');
  const [results, setResults] = useState<CorridorData['train_runs']>([]);
  const [searched, setSearched] = useState(false);
  const router = useRouter();

  useEffect(() => {
    fetch('/data/gyeongbu-corridor.json').then(r => r.json()).then(setData);
  }, []);

  const stations = data?.corridor.stations.map(s => s.name) || [];

  const handleSearch = () => {
    if (!data || from === to) return;
    const fIdx = stations.indexOf(from);
    const tIdx = stations.indexOf(to);
    if (fIdx < 0 || tIdx < 0 || fIdx >= tIdx) return;

    const matched = data.train_runs.filter(train => {
      const fromStop = train.stops.find(s => s.station === from);
      const toStop = train.stops.find(s => s.station === to);
      return fromStop && toStop && fromStop.departure && toStop.arrival;
    });

    setResults(matched);
    setSearched(true);
  };

  const getTime = (train: CorridorData['train_runs'][0], station: string, type: 'arrival' | 'departure') => {
    const s = train.stops.find(st => st.station === station);
    return s ? (type === 'arrival' ? s.arrival : s.departure) : '-';
  };

  const calcDuration = (train: CorridorData['train_runs'][0]) => {
    const fromS = train.stops.find(s => s.station === from);
    const toS = train.stops.find(s => s.station === to);
    if (!fromS?.departure || !toS?.arrival) return '-';
    const [h1, m1] = fromS.departure.split(':').map(Number);
    const [h2, m2] = toS.arrival.split(':').map(Number);
    const diff = (h2 * 60 + m2) - (h1 * 60 + m1);
    return `${Math.floor(diff / 60)}시간 ${diff % 60}분`;
  };

  const countStops = (train: CorridorData['train_runs'][0]) => {
    const fIdx = train.stops.findIndex(s => s.station === from);
    const tIdx = train.stops.findIndex(s => s.station === to);
    return train.stops.slice(fIdx, tIdx + 1).filter(s => s.departure !== s.arrival).length;
  };

  return (
    <main className="min-h-screen flex flex-col">
      {/* 헤더 */}
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <h1 className="text-xl font-bold text-gray-900">🚄 RailFocus</h1>
        <p className="text-sm text-gray-500">경부선 실시간 열차 추적</p>
      </header>

      <div className="flex-1 flex flex-col items-center px-4 py-8 max-w-2xl mx-auto w-full">
        {/* 역 선택 */}
        <div className="w-full bg-white rounded-xl shadow-sm border border-gray-100 p-6 mb-6">
          <div className="grid grid-cols-[1fr,auto,1fr] gap-3 items-end">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1.5">출발역</label>
              <select value={from} onChange={e => setFrom(e.target.value)}
                className="w-full px-3 py-2.5 border border-gray-200 rounded-lg text-sm bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none">
                {stations.map(s => <option key={s} value={s} disabled={s === to}>{s}</option>)}
              </select>
            </div>
            <button onClick={() => { const t = from; setFrom(to); setTo(t); }}
              className="px-3 py-2.5 text-gray-400 hover:text-blue-500 transition-colors">
              ⇄
            </button>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1.5">도착역</label>
              <select value={to} onChange={e => setTo(e.target.value)}
                className="w-full px-3 py-2.5 border border-gray-200 rounded-lg text-sm bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none">
                {stations.map(s => <option key={s} value={s} disabled={s === from}>{s}</option>)}
              </select>
            </div>
          </div>
          <button onClick={handleSearch} disabled={from === to}
            className="mt-4 w-full py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium
              hover:bg-blue-700 disabled:bg-gray-200 disabled:text-gray-400 transition-colors">
            열차 검색
          </button>
        </div>

        {/* 검색 결과 */}
        {searched && (
          <>
            <h2 className="text-sm font-medium text-gray-700 mb-3 self-start">
              {from} → {to}  · {results.length}개 열차
            </h2>
            {results.length === 0 ? (
              <div className="w-full bg-white rounded-xl shadow-sm border border-gray-100 p-8 text-center text-gray-400 text-sm">
                조건에 맞는 열차가 없습니다
              </div>
            ) : (
              <div className="w-full space-y-3">
                {results.map(train => (
                  <div key={train.train_no} onClick={() => router.push(`/focus/${train.train_no}?from=${from}&to=${to}`)}
                    className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 cursor-pointer
                      hover:border-blue-200 hover:shadow-md transition-all">
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium px-2 py-0.5 rounded-full text-white"
                          style={{ backgroundColor: train.color }}>
                          {train.type}
                        </span>
                        <span className="text-sm font-semibold text-gray-900">{train.name}</span>
                      </div>
                      <span className="text-xs text-gray-400">{countStops(train)}개역 정차</span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <div className="text-center">
                        <div className="text-lg font-bold text-gray-900">{getTime(train, from, 'departure')}</div>
                        <div className="text-xs text-gray-500">{from}</div>
                      </div>
                      <div className="flex-1 mx-4 flex flex-col items-center">
                        <span className="text-xs font-medium text-blue-600">{calcDuration(train)}</span>
                        <div className="w-full h-px bg-gray-200 mt-1 relative">
                          <div className="absolute top-0 left-0 w-full h-px border-t border-dashed border-gray-300"></div>
                        </div>
                      </div>
                      <div className="text-center">
                        <div className="text-lg font-bold text-gray-900">{getTime(train, to, 'arrival')}</div>
                        <div className="text-xs text-gray-500">{to}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* 데이터 없음 */}
        {!data && (
          <div className="text-gray-400 text-sm py-12">데이터 로딩 중...</div>
        )}
      </div>
    </main>
  );
}
