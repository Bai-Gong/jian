import { expect,it } from "vitest";
import { containsPoint } from "./canvasGeometry";
it("hits a rotated, displaced, scaled source in canvas coordinates",()=>{
  const layer={x:20,y:0,rotation:90,scale:2,opacity:1};
  expect(containsPoint(layer,10,4,100,100,70,59)).toBe(true);
  expect(containsPoint(layer,10,4,100,100,79,50)).toBe(false);
  expect(containsPoint({...layer,opacity:0},10,4,100,100,70,50)).toBe(false);
});
