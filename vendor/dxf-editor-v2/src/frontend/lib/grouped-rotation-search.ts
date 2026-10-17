import type { DrawableBlock, PlacedDrawableBlock, PolyProgressiveOptions } from '../components/dxf-editor-v2/editor/types';
import { createPackingStartLayout, packingGeometrySignature } from './packing-start-layout';

type Result = { placements: PlacedDrawableBlock[]; usedHeight: number };
type Solver = (blocks: DrawableBlock[], width: number, step: number | null, options: PolyProgressiveOptions) => Promise<Result | null>;
const normalize = (angle: number) => ((angle % 360) + 360) % 360;
const sameAngle = (a: number, b: number) => Math.min(normalize(a-b), normalize(b-a)) < 1e-6;
const staleStart = () => new Error('Die bisherige Anordnung passt nicht zu den aktuellen Schnittteilen. Starte mit „Packen“ eine neue Anordnung.');

/** A sequential portfolio of group-angle assignments around the unchanged packer.
 * All assignments and winner refinement share one wall-clock budget and the same
 * worker limit. Completed candidates are independently validated before selection.
 */
export async function searchGroupedRotations(blocks: DrawableBlock[], width: number, step: number | null,
  options: PolyProgressiveOptions, solve: Solver, validate: (placements: PlacedDrawableBlock[], width: number) => boolean): Promise<Result | null> {
  const extreme=options.extreme!;
  const started=performance.now()-Math.max(0,extreme.preparationElapsedMs ?? 0);
  const deadline=started+extreme.timeBudgetMs;
  const groups=new Map<string,number[]>();
  for (const block of blocks) if (block.rotationGroup && block.rotationGroupAngles?.length) {
    const values=block.rotationGroupAngles;
    if (values.length>360 || values.some(a=>!Number.isFinite(a))) throw new Error('Wähle eine gültige Rotationskopplung.');
    const previous=groups.get(block.rotationGroup);
    if (previous && (values.length!==previous.length || values.some((a,i)=>!sameAngle(a,previous[i])))) throw new Error('Wähle eine gültige Rotationskopplung.');
    groups.set(block.rotationGroup,values);
  }
  const keys=[...groups.keys()];
  let initial=keys.map(key=>normalize(blocks.find(b=>b.rotationGroup===key)!.manualAngleOverride ?? groups.get(key)![0]));
  if (options.initialLayout) {
    if (options.initialLayout.signature!==packingGeometrySignature(blocks,width,step)
      || options.initialLayout.placements.length!==blocks.length) throw staleStart();
    const seen=new Set<number>();
    const angles=new Map<string,number>();
    for (const p of options.initialLayout.placements) {
      if (!Number.isInteger(p.blockIndex) || !blocks[p.blockIndex] || seen.has(p.blockIndex) || !Number.isFinite(p.angle)) throw staleStart();
      seen.add(p.blockIndex);
      const group=blocks[p.blockIndex].rotationGroup;
      if (!group || !groups.has(group)) continue;
      if (!groups.get(group)!.some(a=>sameAngle(a,p.angle)) || (angles.has(group) && !sameAngle(angles.get(group)!,p.angle))) throw staleStart();
      angles.set(group,p.angle);
    }
    initial=keys.map(key=>angles.get(key) ?? initial[keys.indexOf(key)]);
  }
  const limit=Math.min(24,Math.max(2,Math.floor(extreme.timeBudgetMs/4000)),extreme.maxAttempts ?? 10000);
  const assignments:number[][]=[];
  const seen=new Set<string>();
  const add=(values:number[])=>{const key=JSON.stringify(values);if(!seen.has(key)&&assignments.length<limit){seen.add(key);assignments.push(values);}};
  add(initial);
  // Start with coordinate neighbours; then enumerate mixed combinations with a
  // deterministic mixed-radix counter. Never materialize the exponential space.
  for (let i=0;i<keys.length;i++) for (const angle of groups.get(keys[i])!) {
    const next=initial.slice();next[i]=angle;
    if(assignments.length<Math.max(2,Math.ceil(limit/2))) add(next);
  }
  let combinations=1n;
  for(const key of keys) combinations*=BigInt(groups.get(key)!.length);
  // Spread a bounded set across the entire combination space, including angles
  // that differ in many groups, rather than filling the portfolio with neighbours.
  for(let i=0;i<limit;i++) {
    let value=combinations*BigInt(i)/BigInt(limit);
    const next=keys.map(key=>{const list=groups.get(key)!;const angle=list[Number(value%BigInt(list.length))];value/=BigInt(list.length);return angle;});
    add(next);
  }
  let best:Result|null=null, bestAssignment=initial, attempts=0;
  const maxAttempts=extreme.maxAttempts ?? 10000;
  const targetReached=()=>!!(options.stopAtTarget && options.targetLengthMm && best && best.usedHeight<options.targetLengthMm-0.0001);
  const report=(extra: Partial<Parameters<NonNullable<PolyProgressiveOptions['onSearchProgress']>>[0]>={})=>options.onSearchProgress?.({...extra,elapsedMs:performance.now()-started,timeBudgetMs:extreme.timeBudgetMs,attempts,bestHeight:best?.usedHeight});
  const run=async (assignment:number[],duration:number, warmStart:boolean)=>{
    const selected=new Map(keys.map((key,i)=>[key,assignment[i]]));
    const fixed=blocks.map(block=>block.rotationGroup && selected.has(block.rotationGroup)
      ? {...block,manualAngleOverride:selected.get(block.rotationGroup)!,rotationGroupAngles:undefined} : block);
    const indices=new Map(fixed.map((block,i)=>[block,i]));
    const restore=(placements:PlacedDrawableBlock[])=>placements.map(p=>{
      const index=indices.get(p.block);
      if(index===undefined) throw new Error('Unbekanntes Schnittteil');
      const block=blocks[index];return {...p,block,variant:{...p.variant,block}};
    });
    const retain=(result:Result)=>{
      if(result.placements.length!==blocks.length || !validate(result.placements,width)) return;
      const restored={...result,placements:restore(result.placements)};
      if(!best || restored.usedHeight<best.usedHeight-1e-6) {best=restored;bestAssignment=assignment.slice();}
    };
    const start=warmStart && best ? createPackingStartLayout(best.placements,fixed,width,step) ?? undefined
      : options.initialLayout && assignment===assignments[0] ? {...options.initialLayout,signature:packingGeometrySignature(fixed,width,step)} : undefined;
    try {
      const result=await solve(fixed,width,step,{...options,initialLayout:start,
        extreme:{...extreme,timeBudgetMs:Math.max(100,duration),preparationElapsedMs:0,maxAttempts:extreme.maxAttempts===undefined?undefined:Math.max(1,maxAttempts-attempts)},
        onPlacement:state=>options.onPlacement?.({...state,placements:restore(state.placements),attempt:attempts+1,bestHeight:best?.usedHeight}),
        onAttemptResult:state=>{
          retain(state);
          if(state.attempt>0) attempts++;
          options.onAttemptResult?.({...state,placements:restore(state.placements),attempt:attempts,totalAttempts:maxAttempts});
        },
        onSearchProgress:state=>report({stage:state.stage,workers:state.workers,warmStarted:state.warmStarted,rngSeed:state.rngSeed}),
      });
      if(result) retain(result);
    } catch(error) {
      // Width/margin differences can make a particular assignment infeasible.
      // Retain the incumbent and try the other valid group assignments.
      if(options.shouldStop?.()) return;
      if(!best && assignment===assignments[assignments.length-1]) throw error;
    }
    report();
  };
  report();
  const screenDeadline=performance.now()+Math.max(0,deadline-performance.now())*.5;
  for(let i=0;i<assignments.length;i++) {
    if(options.shouldStop?.() || targetReached() || attempts>=maxAttempts || (i>0 && performance.now()>=deadline)) break;
    await run(assignments[i],Math.floor(Math.max(100,screenDeadline-performance.now())/(assignments.length-i)),false);
  }
  if(best && !options.shouldStop?.() && !targetReached() && attempts<maxAttempts && deadline-performance.now()>=100) {
    await run(bestAssignment,Math.floor(deadline-performance.now()),true);
  }
  report();
  return best;
}
