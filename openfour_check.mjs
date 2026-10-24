import {keccak_256} from '@noble/hashes/sha3.js';
import {execFileSync} from 'node:child_process';
const token=process.argv[2];if(!/^0x[\da-fA-F]{40}$/.test(token))throw Error('Invalid token');
const wallet=JSON.parse(execFileSync('baw',['wallet','address','--json'],{encoding:'utf8',timeout:15000})).data.addresses.find(x=>x.binanceChainId==='56').address;
const pad=x=>BigInt(x).toString(16).padStart(64,'0');
async function rpc(method,params){const x=await(await fetch('https://bsc-dataseed.binance.org',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(12000)})).json();return x}
async function call(to,s,args='',value){return rpc('eth_call',[{from:wallet,to,data:'0x'+Buffer.from(keccak_256(new TextEncoder().encode(s))).toString('hex').slice(0,8)+args,...(value?{value}: {})},'latest'])}
try{
const cfg=await(await fetch('https://four.meme/meme-api/v1/public/address',{signal:AbortSignal.timeout(12000)})).json();if(cfg.code!==0)throw Error('Official address API failed');const addresses=Object.fromEntries(cfg.data.filter(x=>x.networkCode==='BSC').map(x=>[x.name,x.address]));const core=addresses.OpenFourCore,tools=addresses.OpenFourTools;if(!core||!tools)throw Error('Missing deployment configuration');
const info=await call(core,'tokens(address)',pad(token));if(info.error)throw Error(info.error.message);const words=info.result.slice(2).match(/.{64}/g);if(words.length<20||('0x'+words[3].slice(24)).toLowerCase()!==token.toLowerCase()||BigInt('0x'+words[17])!==1n)throw Error('Token not registered with OpenFourCore');
const quote=await call(tools,'estimateBuyByBudget(address,address,uint256,uint256,bytes)',pad(token)+pad(wallet)+pad(1000000000000000n)+pad(2)+pad(160)+pad(0));
const simulation=await call(core,'buy(address,uint256,uint256,uint256,bytes)',pad(token)+pad(10n**18n)+pad(10n**15n)+pad(2)+pad(160)+pad(0),'0x38d7ea4c68000');
const allowance=await call(token,'allowance(address,address)',pad(wallet)+pad(core));
const quoteWords=quote.result?.slice(2).match(/.{64}/g)?.map(x=>BigInt('0x'+x).toString());
console.log(JSON.stringify({success:true,data:{wallet,token,protocol:'OpenFour V12',core,tools,registry:addresses.OpenFourRegistry,presetId:BigInt('0x'+words[2]).toString(),quoteAsset:'0x'+words[9].slice(24),tradeModule:'0x'+words[12].slice(24),paused:BigInt('0x'+words[18])!==0n,allowanceRaw:allowance.result?BigInt(allowance.result).toString():null,quoteForBudgetWei:'1000000000000000',quoteWords,simulation,ready:false,blocker:simulation.error?'实际买入只读模拟被合约拒绝：'+simulation.error.message:'单次模拟通过，资格及迁移状态检查仍待完成'}}));
}catch(e){console.log(JSON.stringify({success:false,error:{message:e.message}}))}
