/*
 * dxf_layout.js - liteAECO shared DXF helper
 * Scans raw DXF text for paper-space layouts.
 *
 * DXF stores only the active layout's entities in the ENTITIES section
 * (group 67 = 1); every other layout lives in a *Paper_Space<N> block.
 * Human-readable layout names come from OBJECTS > LAYOUT, which links to
 * a BLOCK_RECORD (group 330) whose name (group 2) is the block name.
 *
 * Exposes window.DxfLayout (browser) / module.exports (Node):
 *   scan(text) -> [{ name, blockName, tabOrder }]
 *     Paper layouts only (Model excluded), sorted by tabOrder.
 *     Falls back to enumerating *Paper_Space* BLOCK names when the
 *     OBJECTS section is missing or unreadable.
 */
(function () {
    'use strict';

    function splitLines(text) {
        return String(text || '').split(/\r\n|\r|\n/);
    }

    // Iterate (code, value) pairs calling cb(code, value, index). Return false to stop.
    function eachPair(lines, start, end, cb) {
        for (var i = start; i + 1 < end; i += 2) {
            var code = parseInt(lines[i], 10);
            if (isNaN(code)) { i -= 1; continue; } // tolerate stray blank line
            var value = lines[i + 1];
            if (cb(code, value === undefined ? '' : value.trim(), i) === false) return;
        }
    }

    function findSection(lines, name) {
        // Returns [startIdx, endIdx) of the section body, or null.
        for (var i = 0; i + 1 < lines.length; i += 1) {
            if (lines[i].trim() === '0' && lines[i + 1] && lines[i + 1].trim() === 'SECTION') {
                // next pair should be 2/<name>
                var j = i + 2;
                while (j + 1 < lines.length && lines[j].trim() === '') j += 1;
                if (lines[j] && lines[j].trim() === '2' && lines[j + 1] && lines[j + 1].trim().toUpperCase() === name) {
                    // find ENDSEC
                    for (var k = j + 2; k + 1 < lines.length; k += 1) {
                        if (lines[k].trim() === '0' && lines[k + 1] && lines[k + 1].trim() === 'ENDSEC') {
                            return [j + 2, k];
                        }
                    }
                    return [j + 2, lines.length];
                }
            }
        }
        return null;
    }

    // BLOCK_RECORD table: handle (5) -> { name (2), layoutHandle (340) }
    function scanBlockRecords(lines, tablesRange) {
        var map = {};
        if (!tablesRange) return map;
        var inBlockRecord = false;
        var current = null;
        function commit() {
            if (current && current.handle && current.name) {
                map[current.handle.toUpperCase()] = { name: current.name, layoutHandle: current.layoutHandle };
            }
            current = null;
        }
        eachPair(lines, tablesRange[0], tablesRange[1], function (code, value) {
            if (code === 0) {
                commit();
                if (value === 'ENDTAB') inBlockRecord = false;
                else if (value === 'BLOCK_RECORD' && inBlockRecord) current = { handle: null, name: null, layoutHandle: null };
                return;
            }
            if (code === 2) {
                if (!inBlockRecord && value.toUpperCase() === 'BLOCK_RECORD') inBlockRecord = true;
                else if (current && current.name === null) current.name = value;
                return;
            }
            if ((code === 5 || code === 105) && current) { current.handle = value; return; }
            if (code === 340 && current) current.layoutHandle = value.toUpperCase();
        });
        commit();
        return map;
    }

    // OBJECTS section: LAYOUT entries -> { name(1), ownerBlockRecordHandle(330), tabOrder(71) }
    function scanLayoutObjects(lines, objectsRange) {
        var layouts = [];
        if (!objectsRange) return layouts;
        var current = null;

        function finish() {
            if (!current) return;
            // AcDbLayout's code 1 is the layout name; AcDbPlotSettings' code 1
            // (page-setup name, usually empty) comes first in real files.
            // Writers that omit the 100 subclass markers: last non-empty wins.
            current.name = current.layoutName !== null ? current.layoutName
                : (current.lastNonEmptyName !== null ? current.lastNonEmptyName : current.firstName);
            layouts.push(current);
            current = null;
        }

        eachPair(lines, objectsRange[0], objectsRange[1], function (code, value) {
            if (code === 0) {
                finish();
                if (value === 'LAYOUT') {
                    current = {
                        name: null, firstName: null, layoutName: null,
                        lastNonEmptyName: null, handle: null,
                        inLayoutSubclass: false,
                        handles330: [], layoutHandles330: [],
                        tabOrder: 0, paperWidth: 0, paperHeight: 0
                    };
                }
                return;
            }
            if (!current) return;
            if (code === 100) {
                current.inLayoutSubclass = value === 'AcDbLayout';
            } else if (code === 1) {
                if (current.inLayoutSubclass && current.layoutName === null) current.layoutName = value;
                else if (current.firstName === null) current.firstName = value;
                if (value !== '') current.lastNonEmptyName = value;
            } else if (code === 5) {
                if (current.handle === null) current.handle = value.toUpperCase();
            } else if (code === 330) {
                var h = value.toUpperCase();
                current.handles330.push(h);
                if (current.inLayoutSubclass) current.layoutHandles330.push(h);
            } else if (code === 71) {
                current.tabOrder = parseInt(value, 10) || 0;
            } else if (code === 44) {
                current.paperWidth = parseFloat(value) || 0;   // plot paper width (mm)
            } else if (code === 45) {
                current.paperHeight = parseFloat(value) || 0;  // plot paper height (mm)
            }
        });
        finish();
        return layouts;
    }

    // LAYER table: handle (5) -> layer name (2). For viewport VP-freeze (331 refs).
    function scanLayerHandles(lines, tablesRange) {
        var map = {};
        if (!tablesRange) return map;
        var inLayer = false;
        var current = null;
        eachPair(lines, tablesRange[0], tablesRange[1], function (code, value) {
            if (code === 0) {
                if (current && current.handle && current.name) map[current.handle.toUpperCase()] = current.name;
                current = null;
                if (value === 'ENDTAB') inLayer = false;
                else if (value === 'LAYER' && inLayer) current = { handle: null, name: null };
                return;
            }
            if (code === 2) {
                if (!inLayer && value.toUpperCase() === 'LAYER') inLayer = true;
                else if (current && current.name === null) current.name = value;
                return;
            }
            if (code === 5 && current) current.handle = value;
        });
        if (current && current.handle && current.name) map[current.handle.toUpperCase()] = current.name;
        return map;
    }

    // VIEWPORT entities from both the ENTITIES section (active layout) and BLOCKS
    // (other layouts). Codes: 10/20 center, 40/41 paper w/h, 12/22 view center,
    // 45 view height, 51 twist, 68 status, 69 id, 331 frozen layer handles.
    function scanViewports(lines, entitiesRange, blocksRange, layerHandleMap) {
        var out = [];
        var current = null;
        var currentBlock = null;

        function push() {
            if (!current) return;
            var vp = current;
            current = null;
            if (!(vp.width > 0) || !(vp.height > 0)) return;
            if (!isFinite(vp.cx) || !isFinite(vp.cy)) return;
            vp.frozenLayers = vp.frozenHandles
                .map(function (h) { return layerHandleMap[h] || null; })
                .filter(function (n) { return !!n; });
            out.push(vp);
        }

        function walk(range, inBlocks) {
            if (!range) return;
            eachPair(lines, range[0], range[1], function (code, value) {
                if (code === 0) {
                    push();
                    if (inBlocks && value === 'BLOCK') { currentBlock = { pendingName: true }; return; }
                    if (inBlocks && value === 'ENDBLK') { currentBlock = null; return; }
                    if (value === 'VIEWPORT') {
                        current = {
                            handle: null, layer: '0',
                            blockName: inBlocks ? (currentBlock && currentBlock.name) || null : null,
                            fromEntities: !inBlocks,
                            cx: NaN, cy: NaN, width: 0, height: 0,
                            viewCenterX: 0, viewCenterY: 0, viewHeight: 0,
                            twistDeg: 0, status: 0, viewId: 0,
                            frozenHandles: [], ownerHandles: []
                        };
                    }
                    return;
                }
                if (inBlocks && currentBlock && currentBlock.pendingName && code === 2) {
                    currentBlock.name = value;
                    currentBlock.pendingName = false;
                    return;
                }
                if (!current) return;
                switch (code) {
                    case 5: current.handle = value; break;
                    case 8: current.layer = value; break;
                    case 10: current.cx = parseFloat(value); break;
                    case 20: current.cy = parseFloat(value); break;
                    case 40: current.width = Math.abs(parseFloat(value)) || 0; break;
                    case 41: current.height = Math.abs(parseFloat(value)) || 0; break;
                    case 12: current.viewCenterX = parseFloat(value) || 0; break;
                    case 22: current.viewCenterY = parseFloat(value) || 0; break;
                    case 45: current.viewHeight = Math.abs(parseFloat(value)) || 0; break;
                    case 51: current.twistDeg = parseFloat(value) || 0; break;
                    case 68: current.status = parseInt(value, 10) || 0; break;
                    case 69: current.viewId = parseInt(value, 10) || 0; break;
                    case 330: current.ownerHandles.push(value.toUpperCase()); break;
                    case 331: current.frozenHandles.push(value.toUpperCase()); break;
                }
            });
            push();
        }

        walk(entitiesRange, false);
        walk(blocksRange, true);
        return out;
    }

    // Fallback: enumerate *Paper_Space* block names from the BLOCKS section.
    function scanPaperBlocks(lines, blocksRange) {
        var names = [];
        if (!blocksRange) return names;
        var expectName = false;
        eachPair(lines, blocksRange[0], blocksRange[1], function (code, value) {
            if (code === 0) { expectName = value === 'BLOCK'; return; }
            if (expectName && code === 2) {
                if (/^\*?PAPER_SPACE/i.test(value)) names.push(value);
                expectName = false;
            }
        });
        return names;
    }

    function isModelBlockName(name) {
        return /^\*?MODEL_SPACE$/i.test(String(name || ''));
    }

    function scan(text) {
        var lines = splitLines(text);
        var tables = findSection(lines, 'TABLES');
        var objects = findSection(lines, 'OBJECTS');
        var blocks = findSection(lines, 'BLOCKS');

        var recordNames = scanBlockRecords(lines, tables);
        var layoutObjs = scanLayoutObjects(lines, objects);
        var paperBlocks = scanPaperBlocks(lines, blocks);

        // Order paper blocks canonically: *Paper_Space, *Paper_Space0, 1, ...
        paperBlocks.sort(function (a, b) {
            var ma = /^\*?PAPER_SPACE(\d*)$/i.exec(a);
            var mb = /^\*?PAPER_SPACE(\d*)$/i.exec(b);
            var na = ma && ma[1] !== '' ? parseInt(ma[1], 10) : -1; // bare name first
            var nb = mb && mb[1] !== '' ? parseInt(mb[1], 10) : -1;
            return na - nb || a.localeCompare(b);
        });

        // A LAYOUT carries several 330 handles (reactors, owner dictionary,
        // block record). The block record is whichever one actually exists in
        // the BLOCK_RECORD table - prefer handles from the AcDbLayout subclass.
        function resolveBlockRecord(lo) {
            var pools = [lo.layoutHandles330 || [], lo.handles330 || []];
            for (var p = 0; p < pools.length; p += 1) {
                var handles = pools[p];
                for (var i = handles.length - 1; i >= 0; i -= 1) {
                    if (recordNames[handles[i]]) return handles[i];
                }
            }
            // Reverse join: a BLOCK_RECORD's code 340 points back at the LAYOUT.
            if (lo.handle) {
                for (var h in recordNames) {
                    if (recordNames[h].layoutHandle === lo.handle) return h;
                }
            }
            return null;
        }
        function blockNameOfRecord(h) {
            return h && recordNames[h] ? recordNames[h].name : null;
        }
        // Reverse map: block name UPPER -> record handle (for fallback rows).
        var recordByBlockName = {};
        for (var rh in recordNames) recordByBlockName[recordNames[rh].name.toUpperCase()] = rh;

        var claimed = {}; // block name UPPER -> true
        var papers = [];
        for (var i = 0; i < layoutObjs.length; i += 1) {
            var lo = layoutObjs[i];
            if (!lo.name) continue;
            var recordHandle = resolveBlockRecord(lo);
            var blockName = blockNameOfRecord(recordHandle);
            if (blockName && isModelBlockName(blockName)) continue;
            if (!blockName && /^MODEL$/i.test(lo.name)) continue;
            papers.push({
                name: lo.name,
                blockName: blockName || null,
                blockRecordHandle: recordHandle || null,
                tabOrder: lo.tabOrder || 0,
                paperWidth: lo.paperWidth || 0,
                paperHeight: lo.paperHeight || 0
            });
        }
        papers.sort(function (a, b) { return a.tabOrder - b.tabOrder || a.name.localeCompare(b.name); });

        // Collision guard: one block per layout - first by tab order keeps it.
        for (var j = 0; j < papers.length; j += 1) {
            var lay = papers[j];
            if (lay.blockName) {
                var key = lay.blockName.toUpperCase();
                if (claimed[key]) { lay.blockName = null; lay.blockRecordHandle = null; }
                else claimed[key] = true;
            }
        }
        // Blockless layouts get the unclaimed paper blocks in canonical order.
        var free = paperBlocks.filter(function (bn) { return !claimed[bn.toUpperCase()]; });
        for (var k = 0; k < papers.length; k += 1) {
            if (!papers[k].blockName && free.length) {
                papers[k].blockName = free.shift();
                papers[k].blockRecordHandle = recordByBlockName[papers[k].blockName.toUpperCase()] || null;
                claimed[papers[k].blockName.toUpperCase()] = true;
            }
        }

        // Fallback ONLY when the file has no readable LAYOUT objects at all:
        // one row per raw *Paper_Space* block, under a readable generic name.
        if (!papers.length) {
            for (var m = 0; m < paperBlocks.length; m += 1) {
                papers.push({
                    name: 'Layout ' + (m + 1),
                    blockName: paperBlocks[m],
                    blockRecordHandle: recordByBlockName[paperBlocks[m].toUpperCase()] || null,
                    tabOrder: 1000 + m, paperWidth: 0, paperHeight: 0
                });
            }
        }

        papers.sort(function (a, b) { return a.tabOrder - b.tabOrder || a.name.localeCompare(b.name); });
        return papers;
    }

    // Viewports across the whole file, tagged with their containing block (or
    // fromEntities:true for the active layout). frozenLayers resolved to names.
    function viewports(text) {
        var lines = splitLines(text);
        var tables = findSection(lines, 'TABLES');
        var entities = findSection(lines, 'ENTITIES');
        var blocks = findSection(lines, 'BLOCKS');
        return scanViewports(lines, entities, blocks, scanLayerHandles(lines, tables));
    }

    var DxfLayout = { scan: scan, viewports: viewports };

    if (typeof window !== 'undefined') {
        window.DxfLayout = DxfLayout;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = DxfLayout;
    }
})();
