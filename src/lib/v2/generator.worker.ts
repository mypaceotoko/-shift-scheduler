import {generate} from './engine';import type {State,Day} from './model';
self.onmessage=(e:MessageEvent<{state:State;start:string;end:string;configs:Day[];preserve:boolean}>)=>{try{const d=e.data;self.postMessage({plan:generate(d.state,d.start,d.end,d.configs,d.preserve)});}catch(error){self.postMessage({error:error instanceof Error?error.message:String(error)});}};
