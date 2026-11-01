// Deterministic code-drawn flag icon; no external fonts or image dependencies.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
function crc32(bytes) { let crc=0xffffffff; for(const b of bytes) { crc^=b; for(let i=0;i<8;i++) crc=(crc>>>1)^((crc&1)?0xedb88320:0); } return (crc^0xffffffff)>>>0; }
function chunk(name,data) { const tag=Buffer.from(name),size=Buffer.alloc(4),crc=Buffer.alloc(4); size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([tag,data]))); return Buffer.concat([size,tag,data,crc]); }
function inside(x,y,points) { let hit=false; for(let i=0,j=points.length-1;i<points.length;j=i++) { const [xi,yi]=points[i], [xj,yj]=points[j]; if((yi>y)!==(yj>y) && x<(xj-xi)*(y-yi)/(yj-yi)+xi) hit=!hit; } return hit; }
const flag=[[34,28],[75,28],[64,43],[75,58],[34,58]];
const star=[[51,36],[53,41],[58,43],[53,45],[51,50],[49,45],[44,43],[49,41]];
for(const size of [192,512]) {
 const raw=Buffer.alloc((size*3+1)*size);
 for(let y=0;y<size;y++) for(let x=0;x<size;x++) {
  const color=[0,0,0];
  for(const dy of [.25,.75]) for(const dx of [.25,.75]) {
   const px=(x+dx)*100/size, py=(y+dy)*100/size;
   let rgb=[24,92,70];
   if(px>=27 && px<=34 && py>=27 && py<=73) rgb=[247,247,238];
   if(inside(px,py,flag)) rgb=[212,230,157];
   if(inside(px,py,star)) rgb=[24,92,70];
   rgb.forEach((value,i)=>{color[i]+=value/4;});
  }
  const offset=y*(size*3+1)+1+x*3; color.forEach((v,i)=>{raw[offset+i]=Math.round(v);});
 }
 const header=Buffer.alloc(13); header.writeUInt32BE(size);header.writeUInt32BE(size,4);header[8]=8;header[9]=2;
 writeFileSync(new URL(`../public/icon-${size}.png`,import.meta.url),Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]));
}
