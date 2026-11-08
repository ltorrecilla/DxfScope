/* Pure paper-viewport geometry shared by Editor and Compare. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DxfViewport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    function project(point, { center, viewCenter, paperHeight, modelHeight, twist = 0 }) {
        if (!point || !center || !viewCenter || !(paperHeight > 0) || !(modelHeight > 0)) return null;
        const scale = paperHeight / modelHeight, dx = point.x - viewCenter.x, dy = point.y - viewCenter.y;
        const c = Math.cos(-twist), s = Math.sin(-twist);
        return { x: center.x + (dx*c - dy*s)*scale, y: center.y + (dx*s + dy*c)*scale, scale };
    }
    function clipRect(a, b, rect) {
        if (!a || !b || !rect) return null;
        const x1=Number(a.x),y1=Number(a.y),x2=Number(b.x),y2=Number(b.y);
        if (![x1,y1,x2,y2,rect.minX,rect.maxX,rect.minY,rect.maxY].every(Number.isFinite)) return null;
        const dx=x2-x1,dy=y2-y1,p=[-dx,dx,-dy,dy],q=[x1-rect.minX,rect.maxX-x1,y1-rect.minY,rect.maxY-y1];
        let u1=0,u2=1;
        for(let i=0;i<4;i++) {
            if(Math.abs(p[i])<1e-12){if(q[i]<0)return null;continue;}
            const t=q[i]/p[i];
            if(p[i]<0){if(t>u2)return null;if(t>u1)u1=t;}
            else{if(t<u1)return null;if(t<u2)u2=t;}
        }
        return {x1:x1+u1*dx,y1:y1+u1*dy,x2:x1+u2*dx,y2:y1+u2*dy};
    }
    function pointInRect(p,r) { return !!p && !!r && p.x>=r.minX && p.x<=r.maxX && p.y>=r.minY && p.y<=r.maxY; }
    function onSegment(p,a,b,eps=1e-8){const cross=(p.y-a.y)*(b.x-a.x)-(p.x-a.x)*(b.y-a.y);if(Math.abs(cross)>eps)return false;const dot=(p.x-a.x)*(b.x-a.x)+(p.y-a.y)*(b.y-a.y);return dot>=-eps&&dot<=(b.x-a.x)**2+(b.y-a.y)**2+eps;}
    function pointInPolygon(p,poly){if(!p||!Array.isArray(poly)||poly.length<3)return false;let inside=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){const a=poly[i],b=poly[j];if(onSegment(p,b,a))return true;if((a.y>p.y)!==(b.y>p.y)&&p.x<(b.x-a.x)*(p.y-a.y)/((b.y-a.y)||1e-12)+a.x)inside=!inside;}return inside;}
    function intersectionT(a,b,c,d){const rx=b.x-a.x,ry=b.y-a.y,sx=d.x-c.x,sy=d.y-c.y,den=rx*sy-ry*sx;if(Math.abs(den)<1e-12)return null;const qx=c.x-a.x,qy=c.y-a.y,t=(qx*sy-qy*sx)/den,u=(qx*ry-qy*rx)/den;return t<-1e-9||t>1+1e-9||u<-1e-9||u>1+1e-9?null:Math.max(0,Math.min(1,t));}
    function clipPolygon(a,b,poly){if(!Array.isArray(poly)||poly.length<3||!a||!b)return [];const ts=[0,1];for(let i=0;i<poly.length;i++){const t=intersectionT(a,b,poly[i],poly[(i+1)%poly.length]);if(t!==null)ts.push(t);}const unique=[...new Set(ts.map(t=>Math.round(t*1e9)/1e9))].sort((x,y)=>x-y),out=[];for(let i=0;i<unique.length-1;i++){const t0=unique[i],t1=unique[i+1];if(t1-t0<=1e-9)continue;const mid={x:a.x+(b.x-a.x)*(t0+t1)/2,y:a.y+(b.y-a.y)*(t0+t1)/2};if(!pointInPolygon(mid,poly))continue;const p={x:a.x+(b.x-a.x)*t0,y:a.y+(b.y-a.y)*t0},q={x:a.x+(b.x-a.x)*t1,y:a.y+(b.y-a.y)*t1};if(Math.hypot(q.x-p.x,q.y-p.y)>1e-9)out.push({x1:p.x,y1:p.y,x2:q.x,y2:q.y});}return out;}
    return {project,clipRect,pointInRect,pointInPolygon,clipPolygon};
});
