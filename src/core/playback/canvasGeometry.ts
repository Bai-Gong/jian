import type { LayerDesc } from "../composite/composite";
/** Inverse of Canvas translate(center + offset), clockwise rotate, uniform scale. */
export function containsPoint(layer: Pick<LayerDesc,"x"|"y"|"rotation"|"scale"|"opacity">,
  sourceWidth:number,sourceHeight:number,width:number,height:number,x:number,y:number):boolean {
  if (layer.scale<=0 || layer.opacity<=0) return false;
  const angle=layer.rotation*Math.PI/180, dx=x-width/2-layer.x, dy=y-height/2-layer.y;
  const sx=(Math.cos(angle)*dx+Math.sin(angle)*dy)/layer.scale;
  const sy=(-Math.sin(angle)*dx+Math.cos(angle)*dy)/layer.scale;
  return Math.abs(sx)<=sourceWidth/2 && Math.abs(sy)<=sourceHeight/2;
}
