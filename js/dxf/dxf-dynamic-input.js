/* Typed 2D point and distance entry shared by the CAD console and floating field. */
(function (root) {
    'use strict';
    const number = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)';
    const coordinates = new RegExp(`^(${number}),(${number})(?:,(${number}))?$`);
    const scalar = new RegExp(`^${number}$`);

    function parse(raw, context = {}) {
        const value = String(raw || '').trim();
        if (!value) return { error: 'Enter x,y, @dx,dy, or a distance.' };
        const relative = value.startsWith('@');
        const match = (relative ? value.slice(1) : value).match(coordinates);
        if (match) {
            const x = Number(match[1]), y = Number(match[2]), z = Number(match[3] || 0);
            if (Math.abs(z) > 1e-9) return { error: 'This 2D editor accepts z=0 only.' };
            if (relative && !context.anchor) return { error: 'Pick a first point before entering a relative coordinate.' };
            const point = { x: x + (relative ? context.anchor.x : 0),
                y: y + (relative ? context.anchor.y : 0) };
            return { kind: 'point', point, relative };
        }
        if (scalar.test(value)) {
            if (!context.anchor) return { error: 'Pick or type a base point before entering a distance.' };
            const cursor = context.pointer;
            const dx = cursor?.x - context.anchor.x, dy = cursor?.y - context.anchor.y;
            const length = Math.hypot(dx, dy);
            if (!(length > 1e-9)) return { error: 'Point the cursor in the desired direction, then enter the distance.' };
            const distance = Number(value);
            return { kind: 'point', point: {
                x: context.anchor.x + distance * dx / length,
                y: context.anchor.y + distance * dy / length,
            }, distance };
        }
        return { error: 'Use dot decimals and commas between coordinates, e.g. 1.5,2 or @-1,2.' };
    }

    const DxfDynamicInput = { parse };
    if (typeof module !== 'undefined' && module.exports) module.exports = DxfDynamicInput;
    if (root) root.DxfDynamicInput = DxfDynamicInput;
})(typeof window !== 'undefined' ? window : null);
