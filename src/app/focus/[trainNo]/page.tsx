'use client';

import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import * as turf from '@turf/turf';

function computeProfile(D: number, T: number, maxV: number, a: number) {
  if (T <= 0) return { aD: 0, cD: 0, dD: 0, aT: 0, cT: 0, dT: 0, v: 0, a, tD: D, tT: 0 };
  const v = Math.min(maxV, a * T / 2);
  const aT_ = v / a, aD_ = v * v / (2 * a);
  if (2 * aD_ >= D) { const v2 = Math.sqrt(a * D), aT2 = v2 / a; return { aD: D/2, cD: 0, dD: D/2, aT: aT2, cT: 0, dT: aT2, v: v2, a, tD: D, tT: 2*aT2 }; }
  return { aD: aD_, cD: D - 2*aD_, dD: aD_, aT: aT_, cT: (D - 2*aD_)/v, dT: aT_, v, a, tD: D, tT: 2*aT_ + (D - 2*aD_)/v };
}
function posAtTime(p: any, e: number) {
  if (e <= 0) return 0;
  if (e >= p.tT) return p.tD;
  if (e < p.aT) return Math.min(0.5*p.a*e*e, p.tD);
  const t1 = e - p.aT;
  if (t1 < p.cT) return Math.min(p.aD + p.v*t1, p.tD);
  const t2 = t1 - p.cT;
  return Math.min(Math.max(p.aD + p.cD + p.v*t2 - 0.5*p.a*t2*t2, 0), p.tD);
}
function speedKmh(p: any, e: number) {
  if (e <= 0 || e >= p.tT - 0.5) return 0;
  if (e < p.aT) return p.a*e*3.6;
  const t1 = e - p.aT;
  if (t1 < p.cT) return p.v*3.6;
  const t2 = t1 - p.cT;
  return Math.max(0, (p.v - p.a*t2))*3.6;
}

export default function FocusPage() {
  const q = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
  const p = typeof window !== 'undefined' ? window.location.pathname.split('/') : [];
  const tNo = p[p.length-1]||'KTX001', fN = q.get('from')||'서울', tN = q.get('to')||'부산';
  const mc=useRef<HTMLDivElement>(null), mR=useRef<maplibregl.Map|null>(null), mkR=useRef<maplibregl.Marker|null>(null);
  const pR=useRef(false), sR=useRef(1), aR=useRef(0), stR=useRef(0), dR=useRef<any>(null), sgR=useRef<any[]>([]);
  const tsR=useRef(0), teR=useRef(0), tcR=useRef(0), lR=useRef<any>(null);
  const [rd,setRd]=useState(false); const [pg,setPg]=useState(0); const [cs,setCs]=useState(fN);
  const [ns,setNs]=useState(''); const [at,setAt]=useState(''); const [el,setEl]=useState(0);
  const [sd,setSd]=useState(1); const [sp,setSp]=useState(0); const [er,setEr]=useState('');
  const [tc,setTc]=useState('#4f46e5'); const [tt,setTt]=useState(''); const [pl,setPl]=useState(false);

  useEffect(() => {
    fetch('/data/gyeongbu-corridor.json').then(r=>r.json()).then(d=>{
      const tr=d.train_runs.find((x:any)=>x.train_no===tNo);
      if(!tr){setEr('no train');return;}
      dR.current={...d,train:tr}; setTc(tr.color); setTt(tr.type);
      const dp=tr.stops.find((s:any)=>s.station===fN), ar=tr.stops.find((s:any)=>s.station===tN);
      if(dp?.departure&&ar?.arrival){
        const[h1,m1]=dp.departure.split(':').map(Number),[h2,m2]=ar.arrival.split(':').map(Number);
        tcR.current=(h2*60+m2-h1*60-m1)*60; setAt(ar.arrival);
      }
      if(!mc.current)return;
      const coords=d.corridor.geometry.coordinates;
      const map=new maplibregl.Map({container:mc.current,style:'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',center:[128.0,36.3],zoom:8,attributionControl:false});
      map.addControl(new maplibregl.FullscreenControl({container:document.body}),'top-right');
      map.on('load',()=>{
        map.addSource('c',{type:'geojson',data:{type:'Feature',geometry:{type:'LineString',coordinates:coords},properties:{}}});
        map.addLayer({id:'cl',type:'line',source:'c',paint:{'line-color':'#93c5fd','line-width':3}});
        d.corridor.stations.forEach((s:any)=>{
          const el=document.createElement('div'), sz=s.name===fN||s.name===tN?'12':'6';
          el.style.cssText=`width:${sz}px;height:${sz}px;border-radius:50%;background:${s.name===fN||s.name===tN?'#3b82f6':'#9ca3af'};border:2px solid white`;
          new maplibregl.Marker({element:el}).setLngLat([s.lng,s.lat]).addTo(map);
        });
        const md=document.createElement('div');
        md.style.cssText=`width:22px;height:22px;border-radius:50%;background:${tr.color};border:3px solid white;box-shadow:0 0 15px rgba(79,70,229,0.7)`;
        const mk=new maplibregl.Marker({element:md}).setLngLat([coords[0][0],coords[0][1]]).addTo(map);
        mkR.current=mk; mR.current=map; map.flyTo({center:[coords[10][0],coords[10][1]],zoom:10,duration:800});
        const line=turf.lineString(coords); lR.current=line;
        const fi=tr.stops.findIndex((s:any)=>s.station===fN), ti=tr.stops.findIndex((s:any)=>s.station===tN);
        const mxV=tr.type==='KTX'?85:42, ac=tr.type==='KTX'?0.5:0.194;
        const segs:any[]=[];
        for(let i=fi;i<ti;i++){
          const s=tr.stops[i], ns=tr.stops[i+1];
          if(!s.departure||!ns.arrival)continue;
          const[h1,m1]=s.departure.split(':').map(Number),[h2,m2]=ns.arrival.split(':').map(Number);
          const T=(h2*60+m2-h1*60-m1)*60; if(T<=0)continue;
          const fs=d.corridor.stations.find((x:any)=>x.name===s.station), ts=d.corridor.stations.find((x:any)=>x.name===ns.station);
          if(!fs||!ts)continue;
          segs.push({fD:fs.corridor_dist_m,tD:ts.corridor_dist_m,p:computeProfile(ts.corridor_dist_m-fs.corridor_dist_m,T,mxV,ac)});
        }
        sgR.current=segs; tsR.current=segs.reduce((s:number,sg:any)=>s+sg.p.tT,0); teR.current=segs.length>0?segs[segs.length-1].tD:0; setRd(true);
      });
    }).catch(()=>setEr('load fail'));
    return()=>{mR.current?.remove();mR.current=null;mkR.current=null;};
  },[tNo,fN,tN]);

  const doPlay = () => {
    if(pR.current||!mkR.current||sgR.current.length===0)return;
    const segs=sgR.current, line=lR.current, endDist=teR.current, simTotal=tsR.current, secTotal=tcR.current;
    const stops=dR.current.train.stops, fromIdx=stops.findIndex((s:any)=>s.station===fN), toName=tN;
    stR.current=performance.now(); pR.current=true; setPl(true);

    function anim(){
      if(!pR.current||!mkR.current||!mR.current)return;
      const se=(performance.now()-stR.current)/1000*sR.current;
      if(se>=simTotal){
        const pt=turf.along(line,endDist,{units:'meters'});
        mkR.current.setLngLat(pt.geometry.coordinates as [number,number]);
        setPg(1);setCs(toName);setNs('');setEl(Math.round(secTotal));setSp(0);
        pR.current=false;setPl(false);return;
      }
      let segE=se, segIdx=0;
      for(let i=0;i<segs.length;i++){if(se<=segs[i].p.tT){segIdx=i;break;} segE-=segs[i].p.tT;}
      if(segIdx>=segs.length){segIdx=segs.length-1;segE=segs[segIdx].p.tT;}
      const seg=segs[segIdx], dist=seg.fD+posAtTime(seg.p,Math.max(0,segE));
      const pt=turf.along(line,Math.min(dist,endDist),{units:'meters'});
      mkR.current.setLngLat(pt.geometry.coordinates as [number,number]);
      mR.current.panTo(pt.geometry.coordinates as [number,number],{duration:200,animate:true});
      setPg(Math.min(1,se/simTotal)); setEl(Math.round(Math.min(secTotal,se)));
      setSp(Math.round(speedKmh(seg.p,Math.max(0,segE))));
      setCs(stops[fromIdx+segIdx].station);
      setNs(segIdx+1<segs.length?stops[fromIdx+segIdx+1].station:'');
      aR.current=requestAnimationFrame(anim);
    }
    aR.current=requestAnimationFrame(anim);
  };

  return (
    <div style={{width:'100%',height:'100vh',position:'relative',overflow:'hidden',background:'#111827'}}>
      <div ref={mc} style={{position:'absolute',inset:0}} />
      {!rd&&<div style={{position:'absolute',inset:0,display:'flex',alignItems:'center',justifyContent:'center',background:'#f9fafb',zIndex:10000}}><div style={{color:'#9ca3af'}}>로딩 중...</div></div>}
      {rd&&<div style={{position:'absolute',inset:0,zIndex:10000,pointerEvents:'none'}}><div style={{position:'absolute',bottom:0,left:0,right:0,pointerEvents:'auto'}}>
        <div style={{background:'white',borderTopLeftRadius:16,borderTopRightRadius:16,boxShadow:'0 25px 50px rgba(0,0,0,0.25)',padding:'16px 16px 24px',borderTop:'4px solid #3b82f6'}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
            <div style={{display:'flex',gap:8,alignItems:'center'}}>
              <span style={{fontSize:12,fontWeight:700,padding:'2px 8px',borderRadius:999,color:'white',background:tc}}>{tt}</span>
              <span style={{fontSize:14,fontWeight:600}}>{tNo}</span></div><span style={{fontSize:12,color:'#6b7280'}}>{fN} → {tN}</span></div>
          <div style={{width:'100%',height:8,background:'#e5e7eb',borderRadius:999,overflow:'hidden',marginBottom:12}}>
            <div style={{height:'100%',background:'#3b82f6',borderRadius:999,transition:'width 100ms',width:`${pg*100}%`}}/></div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(5,1fr)',gap:4,textAlign:'center',marginBottom:12}}>
            <div><div style={{fontSize:10,color:'#6b7280'}}>현재역</div><div style={{fontSize:13,fontWeight:700,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{cs}</div></div>
            <div><div style={{fontSize:10,color:'#6b7280'}}>다음역</div><div style={{fontSize:13,fontWeight:700,color:'#2563eb',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{ns||'도착'}</div></div>
            <div><div style={{fontSize:10,color:'#6b7280'}}>경과</div><div style={{fontSize:13,fontWeight:700}}>{el>0?Math.floor(el/60)+'분 '+el%60+'초':'0'}</div></div>
            <div><div style={{fontSize:10,color:'#6b7280'}}>속도</div><div style={{fontSize:13,fontWeight:700,color:'#059669'}}>{sp}km/h</div></div>
            <div><div style={{fontSize:10,color:'#6b7280'}}>도착</div><div style={{fontSize:13,fontWeight:700}}>{at||'-'}</div></div></div>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
            <div style={{display:'flex',gap:8}}>
              <button onClick={()=>{pR.current=false;setPl(false);cancelAnimationFrame(aR.current);setPg(0);setEl(0);setCs(fN);setNs('');setSp(0);
                if(mkR.current&&dR.current){mkR.current.setLngLat([dR.current.corridor.geometry.coordinates[0][0],dR.current.corridor.geometry.coordinates[0][1]]);}
              }} style={{padding:'8px 12px',fontSize:14,background:'#f3f4f6',border:'none',borderRadius:12,fontWeight:500,cursor:'pointer'}}>⟲</button>
              {pl?(<button onClick={()=>{pR.current=false;setPl(false);cancelAnimationFrame(aR.current);}} style={{padding:'12px 32px',fontSize:16,fontWeight:700,color:'white',background:'#dc2626',border:'none',borderRadius:12,cursor:'pointer'}}>⏸ 정지</button>)
              :(<button onClick={doPlay} style={{padding:'12px 32px',fontSize:16,fontWeight:700,color:'white',background:'#2563eb',border:'none',borderRadius:12,boxShadow:'0 10px 15px -3px rgba(37,99,235,0.2)',cursor:'pointer'}}>▶ 재생</button>)}
            </div>
            <div style={{display:'flex',gap:4}}>{[1,2,5,10].map(s=>(
              <button key={s} onClick={()=>{setSd(s);sR.current=s;}} style={{padding:'6px 12px',fontSize:12,fontWeight:700,border:'none',borderRadius:8,cursor:'pointer',background:sd===s?'#2563eb':'#f3f4f6',color:sd===s?'white':'#4b5563'}}>{s}×</button>
            ))}</div>
          </div>
        </div>
      </div></div>}
    </div>
  );
}
