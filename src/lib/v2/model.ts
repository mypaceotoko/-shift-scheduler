import { z } from 'zod';
export const RULES = {version:'2026.10.24',weekday:1440,holidayTarget:1680,holidayLimit:1800,kbMinutes:[240,480],frontMinimum:2,porterMinimum:2,holidayMinimum:3} as const;
const clock=z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const iso=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>{const d=new Date(s+'T00:00:00Z');return !isNaN(+d)&&d.toISOString().slice(0,10)===s;},'日付が不正です');
export const sourceSchema=z.object({file:z.string(),page:z.number().optional(),cell:z.string().optional(),confidence:z.number().optional(),bbox:z.object({x0:z.number(),y0:z.number(),x1:z.number(),y1:z.number()}).optional()});
export const wishSchema=z.object({raw:z.string(),kind:z.enum(['available','off','leave','fixed','window','unknown']),start:clock.optional(),end:clock.optional(),code:z.string().optional(),reviewed:z.boolean(),source:sourceSchema.optional()});
export const personSchema=z.object({id:z.string(),name:z.string().min(1).max(100),department:z.enum(['porter','front']),contract:z.enum(['general','kb','unknown']),active:z.boolean(),maxWeek:z.number().int().min(0).max(7).optional(),maxTotal:z.number().int().min(0).max(62).optional(),maxConsecutive:z.number().int().min(1).max(62).optional(),allowed:z.array(z.string()).default([]),excluded:z.array(z.string()).default([]),notes:z.string().default(''),wishes:z.record(iso,wishSchema)});
export const shiftSchema=z.object({department:z.enum(['porter','front']),code:z.string().min(1),start:clock,end:clock,rest:z.number().int().min(0).max(120)});
export const daySchema=z.object({date:iso,porterClosed:z.boolean().default(false),frontClosed:z.boolean().default(false),holiday:z.boolean().optional(),open:clock.default('10:00'),close:clock.default('23:00'),event:z.string().default('')});
export const assignmentSchema=z.object({personId:z.string(),date:iso,code:z.string(),start:clock,end:clock,rest:z.number().int().min(0).max(120),breakStart:clock.optional(),manual:z.boolean().default(false)});
export const planSchema=z.object({start:iso,end:iso,assignments:z.array(assignmentSchema),days:z.array(daySchema),lockedOff:z.array(z.string()).default([]),generatedAt:z.string().optional(),ruleVersion:z.string().optional()}).refine(s=>s.start<=s.end&&days(s.start,s.end).length<=62,'対象期間は1〜62日です');
export const stateSchema=z.object({schemaVersion:z.literal(2),people:z.array(personSchema),shifts:z.array(shiftSchema),plan:planSchema.nullable(),consecutive:z.number().int().min(1).max(62).default(5),balance:z.boolean().default(true)}).superRefine((s,ctx)=>{if(new Set(s.people.map(p=>p.id)).size!==s.people.length)ctx.addIssue({code:'custom',message:'スタッフIDが重複しています'});if(new Set(s.people.map(p=>p.name.replace(/\s/g,''))).size!==s.people.length)ctx.addIssue({code:'custom',message:'氏名が重複しています'});for(const shift of s.shifts)if(minutes(shift.start)>=minutes(shift.end)||minutes(shift.end)-minutes(shift.start)<=shift.rest)ctx.addIssue({code:'custom',message:'勤務コードの時間が不正です'});});
export type Wish=z.infer<typeof wishSchema>;export type Person=z.infer<typeof personSchema>;export type Shift=z.infer<typeof shiftSchema>;export type Day=z.infer<typeof daySchema>;export type Assignment=z.infer<typeof assignmentSchema>;export type Plan=z.infer<typeof planSchema>;export type State=z.infer<typeof stateSchema>;
export const minutes=(s:string)=>Number(s.slice(0,2))*60+Number(s.slice(3));
export const time=(n:number)=>`${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`;
export function days(start:string,end:string){const result:string[]=[];if(!/^\d{4}-\d{2}-\d{2}$/.test(start)||!/^\d{4}-\d{2}-\d{2}$/.test(end)||start>end)return result;const d=new Date(start+'T00:00:00Z');if(isNaN(+d))return result;for(let n=0;n<367;n++){const s=d.toISOString().slice(0,10);if(s>end)break;result.push(s);d.setUTCDate(d.getUTCDate()+1);}return result;}
export function parseWish(raw:unknown,reviewed=false):Wish{
 const original=String(raw??'').trim(),s=original.normalize('NFKC').replace(/[◯〇]/g,'○').replace(/[‐‑‒–—―ー−ｰ〜～~]/g,'-').replace(/\s/g,'');const base={raw:original,reviewed};
 if(/^(\/|×|✕|x|X|休|公休|OFF|off|不可|NG)$/.test(s))return {...base,kind:'off'};
 if(/^(有|有給|有休)$/.test(s))return {...base,kind:'leave'};
 if(/^(○|可|出勤|OK|ok)$/.test(s))return {...base,kind:'available'};
 if(/^[STBCDFEA]$/.test(s))return {...base,kind:'fixed',code:s};
 const m=s.match(/^(\d{1,2}(?::\d{2}|\.5)?)?-(\d{1,2}(?::\d{2}|\.5)?)?$/);
 const toClock=(v:string)=>v.includes(':')?v.padStart(5,'0'):`${String(Math.floor(+v)).padStart(2,'0')}:${v.endsWith('.5')?'30':'00'}`;
 if(m&&(m[1]||m[2])){const start=m[1]?toClock(m[1]):'09:30',end=m[2]?toClock(m[2]):'23:00';if(clock.safeParse(start).success&&clock.safeParse(end).success&&start<end)return {...base,kind:'window',start,end};}
 return {...base,kind:'unknown'};
}
const shifts=(department:'porter'|'front',codes:[string,string,string][]):Shift[]=>codes.map(([code,start,end])=>({department,code,start,end,rest:60}));
export const DEFAULT_SHIFTS:Shift[]=[...shifts('porter',[['S','09:30','18:30'],['T','09:45','18:45'],['B','10:00','19:00'],['C','11:00','20:00'],['D','12:00','21:00'],['F','14:00','23:00']]),...shifts('front',[['A','08:45','17:45'],['B','10:00','19:00'],['C','11:00','20:00'],['D','12:00','21:00'],['E','13:00','22:00'],['F','14:00','23:00']])];
export const initialState=():State=>({schemaVersion:2,people:[],shifts:DEFAULT_SHIFTS,plan:null,consecutive:5,balance:true});
export const defaultDay=(date:string):Day=>({date,porterClosed:false,frontClosed:false,open:'10:00',close:'23:00',event:''});
