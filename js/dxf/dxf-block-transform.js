/* Shared 2D affine and INSERT transform math for Editor and Compare. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.DxfBlockTransform = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    function makeMatrix(a=1,b=0,c=0,d=1,e=0,f=0) { return { a,b,c,d,e,f }; }
    function multiplyMatrix(m,n) { return makeMatrix(m.a*n.a+m.c*n.b,m.b*n.a+m.d*n.b,m.a*n.c+m.c*n.d,m.b*n.c+m.d*n.d,m.a*n.e+m.c*n.f+m.e,m.b*n.e+m.d*n.f+m.f); }
    function translationMatrix(x=0,y=0) { return makeMatrix(1,0,0,1,x,y); }
    function scaleMatrix(x=1,y=1) { return makeMatrix(x,0,0,y,0,0); }
    function rotationMatrix(deg=0) { const r=Number(deg||0)*Math.PI/180,c=Math.cos(r),s=Math.sin(r); return makeMatrix(c,s,-s,c,0,0); }
    function getPointCandidate(...points) { for(const pt of points) { if(!pt)continue; const x=Number(pt.x),y=Number(pt.y); if(Number.isFinite(x)&&Number.isFinite(y))return {x,y,z:Number(pt.z||0)}; } return null; }
    function transformPoint2D(pt,m=makeMatrix()) { const p=getPointCandidate(pt); return p?{x:m.a*p.x+m.c*p.y+m.e,y:m.b*p.x+m.d*p.y+m.f,z:p.z||0}:null; }
    function transformVector2D(vec,m=makeMatrix()) { const p=getPointCandidate(vec); return p?{x:m.a*p.x+m.c*p.y,y:m.b*p.x+m.d*p.y,z:p.z||0}:null; }
    function getMatrixRotation(m=makeMatrix()) { return Math.atan2(m.b,m.a)*180/Math.PI; }
    function getMatrixScale(m=makeMatrix()) { return ((Math.hypot(m.a,m.b)||1)+(Math.hypot(m.c,m.d)||1))/2; }
    function resolveEntityLayer(entity,inheritedLayer) { const layer=entity?.layer||''; return (!layer||layer==='0')&&inheritedLayer?inheritedLayer:layer||inheritedLayer||'0'; }
    function getInsertMatrix(entity,block,parentMatrix=makeMatrix(),rotation=0) {
        const p=getPointCandidate(entity?.position,entity?.startPoint,entity?.insertPoint,entity?.insertionPoint,entity?.point)||{x:0,y:0};
        const base=getPointCandidate(block?.position,block?.basePoint)||{x:0,y:0};
        const sx=Number(entity?.xScale??entity?.scaleX??entity?.scale?.x??entity?.scale??1)||1;
        const sy=Number(entity?.yScale??entity?.scaleY??entity?.scale?.y??entity?.scale??1)||1;
        return multiplyMatrix(multiplyMatrix(multiplyMatrix(multiplyMatrix(parentMatrix,translationMatrix(p.x,p.y)),rotationMatrix(rotation)),scaleMatrix(sx,sy)),translationMatrix(-base.x,-base.y));
    }
    return {makeMatrix,multiplyMatrix,translationMatrix,scaleMatrix,rotationMatrix,getPointCandidate,transformPoint2D,transformVector2D,getMatrixRotation,getMatrixScale,resolveEntityLayer,getInsertMatrix};
});
