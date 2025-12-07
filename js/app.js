const CONFIG = {
    // Court styling
    COURT_FILL: '#f2dfc6',
    LINE_COLOR: '#1f1f1f',
    LINE_WIDTH: 3,
    RIM_COLOR: '#c96b00',

    // Shot dots
    DOT_R: 3,
    DOT_A: 0.55,

    // Court geometry
    HOOP_Y: 5.25,
    ORIGIN_AT_RIM: false,

    // Jitter for 2016-2017 seasons
    JITTER_16_17: 0.2,

    // 2020-2022 scaling constants
    A_2020_22: 10.021576503177235,
    B_2020_22: -58.588293955235294,
    SCALE_2020_22: 1.0175,

    // Animation
    AUTOPLAY_DELAY_MS: 1000,

    // Three-point geometry
    THREE_R: 23.75,
    CORNER: 22
};

// Computed values
CONFIG.Y_BREAK = CONFIG.HOOP_Y + Math.sqrt(CONFIG.THREE_R * CONFIG.THREE_R - CONFIG.CORNER * CONFIG.CORNER);
CONFIG.THETA = Math.acos(CONFIG.CORNER / CONFIG.THREE_R);
CONFIG.ARC_LEFT = Math.PI - CONFIG.THETA;
CONFIG.ARC_RIGHT = CONFIG.THETA;

// Random normal generator for jitter
const randn = () => {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v) * CONFIG.JITTER_16_17;
};

// ============================================
// Global State
// ============================================
let allData = [];
let cf = null;
let dimensions = {};
let currentFilters = {
    season: 'all',  // 'all' or a year number (2004-2024)
    teams: [],
    positions: [],
    players: [],
    zones: [],
    shotResult: 'all'
};
let isPlaying = false;
let playInterval = null;
let leagueFg = 0;

let chartWidth, chartHeight, xScale, yScale, ctx, CX, CY, zonesLayer;

// ============================================
// Utility Functions
// ============================================
const toFeet = (v) => {
    const n = +v;
    return Math.abs(n) > 60 ? n / 10 : n;
};

const fmtInt = (n) => n.toLocaleString();
const fmtPct = (v) => (v * 100).toFixed(1) + '%';
const fmtPctDiff = (v) => v >= 0 ? `+${(v * 100).toFixed(1)} pp` : `${(v * 100).toFixed(1)} pp`;

// ============================================
// Data Loading
// ============================================

// Set to true to load full data from yearly files, false for sampled data
const USE_FULL_DATA = false;

async function loadData() {
    const loadingProgress = document.getElementById('loading-progress');

    try {
        let rawData = [];

        if (USE_FULL_DATA) {
            // Load all yearly files
            const years = [];
            for (let y = 2004; y <= 2024; y++) years.push(y);

            for (let i = 0; i < years.length; i++) {
                const year = years[i];
                const url = `../../data/NBA_${year}_Shots.csv`;
                console.log(`Loading ${year}...`);

                try {
                    const yearData = await d3.csv(url);
                    rawData = rawData.concat(yearData);
                    loadingProgress.style.width = `${((i + 1) / years.length * 100).toFixed(0)}%`;
                } catch (e) {
                    console.warn(`Could not load ${url}:`, e.message);
                }
            }
        } else {
            // Load sampled data
            rawData = await d3.csv('data/nba_shots_sampled.csv');
            loadingProgress.style.width = '100%';
        }

        // Process each row with coordinate transformations
        allData = rawData.map((d, i) => {
            const year = +d.SEASON_1;
            const locX = +d.LOC_X;
            const locY = +d.LOC_Y;

            let xTrue, yTrue;

            // Apply season-specific coordinate transformations
            if (year >= 2020 && year <= 2022) {
                const baseX = 10 * locX;
                const baseVert = CONFIG.A_2020_22 * locY + CONFIG.B_2020_22;
                const xAdj = CONFIG.SCALE_2020_22 * baseX;
                const vertAdj = CONFIG.SCALE_2020_22 * baseVert;
                xTrue = -xAdj;
                yTrue = CONFIG.HOOP_Y + vertAdj;
            } else if (year === 2016 || year === 2017) {
                const xFeet = toFeet(locX);
                const yFeet = CONFIG.ORIGIN_AT_RIM ? CONFIG.HOOP_Y + toFeet(locY) : toFeet(locY);
                xTrue = xFeet + randn();
                yTrue = yFeet + randn();
            } else {
                const xFeet = toFeet(locX);
                const yRaw = toFeet(locY);
                xTrue = xFeet;
                yTrue = CONFIG.ORIGIN_AT_RIM ? CONFIG.HOOP_Y + yRaw : yRaw;
            }

            return {
                ...d,
                _x: xTrue,
                _y: yTrue,
                _made: d.SHOT_MADE === 'True' || d.SHOT_MADE === 'true' || d.SHOT_MADE === '1' || d.SHOT_MADE === true,
                _player: d.PLAYER_NAME || '',
                _team: d.TEAM_NAME || '',
                _pos: d.POSITION_GROUP || d.POSITION || '',
                _zone: d.BASIC_ZONE || d.SHOT_ZONE_BASIC || '',
                SEASON_1: String(year),
                LOC_X: +d.LOC_X,
                LOC_Y: +d.LOC_Y,
                SHOT_DISTANCE: +d.SHOT_DISTANCE
            };
        }).filter(d => d._pos && d._pos.trim() !== '');

        console.log(`Loaded ${allData.length.toLocaleString()} shots`);
        return allData;

    } catch (error) {
        console.error('Error loading data:', error);
        throw error;
    }
}

// ============================================
// Crossfilter Setup
// ============================================
function setupCrossfilter(data) {
    cf = crossfilter(data);

    dimensions = {
        season: cf.dimension(d => d.SEASON_1),
        team: cf.dimension(d => d._team),
        position: cf.dimension(d => d._pos),
        player: cf.dimension(d => d._player),
        zone: cf.dimension(d => d._zone),
        shotMade: cf.dimension(d => d._made),
        shotType: cf.dimension(d => d.SHOT_TYPE),
        all: cf.dimension(d => d)
    };

    return { cf, dimensions };
}

// ============================================
// Filter Population
// ============================================
function populateFilters() {
    const seasonData = getSeasonData();

    const teams = [...new Set(seasonData.map(d => d._team))].filter(Boolean).sort();
    const players = [...new Set(seasonData.map(d => d._player))].filter(Boolean).sort();
    const zones = [...new Set(seasonData.map(d => d._zone))].filter(Boolean).sort();

    populateSelect('teamFilter', teams, currentFilters.teams);
    populateSelect('playerFilter', players, currentFilters.players);
    populateSelect('zoneFilter', zones, currentFilters.zones);

    // Populate season dropdown
    const seasonDropdown = document.getElementById('seasonDropdown');
    seasonDropdown.innerHTML = '';

    // Add "All Seasons" option
    const allOption = document.createElement('option');
    allOption.value = 'all';
    allOption.textContent = 'All';
    if (currentFilters.season === 'all') allOption.selected = true;
    seasonDropdown.appendChild(allOption);

    for (let year = 2004; year <= 2024; year++) {
        const option = document.createElement('option');
        option.value = year;
        option.textContent = year;
        if (year === currentFilters.season) option.selected = true;
        seasonDropdown.appendChild(option);
    }
}

function populateSelect(id, values, selectedValues = []) {
    const select = document.getElementById(id);
    const selectedSet = new Set(selectedValues);

    select.innerHTML = values.map(v => {
        const selected = selectedSet.has(v) ? 'selected' : '';
        return `<option value="${v}" ${selected}>${v}</option>`;
    }).join('');
}

function getSeasonData() {
    if (currentFilters.season === 'all') {
        return allData;
    }
    return allData.filter(d => d.SEASON_1 === String(currentFilters.season));
}

// ============================================
// Search Filtering for Dropdowns
// ============================================
function filterSelectOptions(selectId, searchTerm) {
    const select = document.getElementById(selectId);
    const term = searchTerm.toLowerCase();

    Array.from(select.options).forEach(option => {
        const matches = !term || option.value.toLowerCase().includes(term);
        option.style.display = matches ? '' : 'none';
    });
}

// ============================================
// Court Drawing
// ============================================
function drawCourt() {
    const container = document.getElementById('court-container');
    const containerWidth = container.clientWidth;

    // Calculate dimensions - scale to fill container width
    chartWidth = containerWidth - 20;
    chartHeight = chartWidth * 0.9;

    const margin = { top: 12, right: 12, bottom: 12, left: 12 };

    // Create scales (in feet)
    xScale = d3.scaleLinear()
        .domain([-25, 25])
        .range([margin.left, chartWidth - margin.right]);

    yScale = d3.scaleLinear()
        .domain([0, 47])
        .range([chartHeight - margin.bottom, margin.top]);

    // Center points for rotation
    CX = chartWidth / 2;
    CY = chartHeight / 2;

    // Clear container
    container.innerHTML = '';

    // Create wrapper div to hold both SVG and canvas (for proper alignment)
    const wrapper = document.createElement('div');
    wrapper.style.position = 'relative';
    wrapper.style.width = `${chartWidth}px`;
    wrapper.style.height = `${chartHeight}px`;
    container.appendChild(wrapper);

    // Create SVG inside wrapper
    const svg = d3.select(wrapper)
        .append('svg')
        .attr('width', chartWidth)
        .attr('height', chartHeight)
        .style('display', 'block')
        .style('background', CONFIG.COURT_FILL);

    // Wood plank pattern
    const defs = svg.append('defs');
    const pattern = defs.append('pattern')
        .attr('id', 'planks')
        .attr('patternUnits', 'userSpaceOnUse')
        .attr('width', 60)
        .attr('height', 60);

    pattern.append('rect')
        .attr('width', 60)
        .attr('height', 60)
        .attr('fill', CONFIG.COURT_FILL);

    pattern.append('rect')
        .attr('x', 0).attr('y', 0)
        .attr('width', 60).attr('height', 6)
        .attr('fill', '#e8cfb0');

    pattern.append('rect')
        .attr('x', 0).attr('y', 30)
        .attr('width', 60).attr('height', 6)
        .attr('fill', '#e8cfb0');

    pattern.append('line')
        .attr('x1', 0).attr('y1', 15)
        .attr('x2', 60).attr('y2', 15)
        .attr('stroke', '#e3c8a7')
        .attr('stroke-width', 0.8)
        .attr('opacity', 0.6);

    pattern.append('line')
        .attr('x1', 0).attr('y1', 45)
        .attr('x2', 60).attr('y2', 45)
        .attr('stroke', '#e3c8a7')
        .attr('stroke-width', 0.8)
        .attr('opacity', 0.6);

    // Background with pattern
    svg.append('rect')
        .attr('x', 0)
        .attr('y', 0)
        .attr('width', chartWidth)
        .attr('height', chartHeight)
        .attr('fill', 'url(#planks)');

    // Create rotated group for court lines
    const root = svg.append('g')
        .attr('transform', `rotate(180, ${CX}, ${CY})`);

    const court = root.append('g')
        .attr('stroke', CONFIG.LINE_COLOR)
        .attr('stroke-width', CONFIG.LINE_WIDTH)
        .attr('fill', 'none');

    // Rim (hoop)
    court.append('circle')
        .attr('cx', xScale(0))
        .attr('cy', yScale(CONFIG.HOOP_Y))
        .attr('r', Math.abs(xScale(0.75) - xScale(0)))
        .attr('stroke', CONFIG.RIM_COLOR)
        .attr('stroke-width', CONFIG.LINE_WIDTH);

    // Backboard
    court.append('rect')
        .attr('x', xScale(-3))
        .attr('y', yScale(4))
        .attr('width', xScale(3) - xScale(-3))
        .attr('height', Math.max(1, 0.12 * Math.abs(yScale(1) - yScale(0))))
        .attr('fill', CONFIG.LINE_COLOR)
        .attr('stroke', 'none');

    // Paint/Key
    court.append('rect')
        .attr('x', xScale(-8))
        .attr('y', yScale(19))
        .attr('width', xScale(8) - xScale(-8))
        .attr('height', yScale(0) - yScale(19));

    // Free throw circle
    court.append('circle')
        .attr('cx', xScale(0))
        .attr('cy', yScale(19))
        .attr('r', Math.abs(xScale(6) - xScale(0)));

    // Three-point line
    const threeR = CONFIG.THREE_R;
    const corner = CONFIG.CORNER;
    const yBreak = CONFIG.Y_BREAK;

    // Corner threes
    court.append('line')
        .attr('x1', xScale(-corner))
        .attr('y1', yScale(0))
        .attr('x2', xScale(-corner))
        .attr('y2', yScale(yBreak));

    court.append('line')
        .attr('x1', xScale(corner))
        .attr('y1', yScale(0))
        .attr('x2', xScale(corner))
        .attr('y2', yScale(yBreak));

    // Three-point arc
    const arcPoints = d3.range(0, 1.0001, 1 / 160).map(t => {
        const a = CONFIG.ARC_LEFT + (CONFIG.ARC_RIGHT - CONFIG.ARC_LEFT) * t;
        const x = threeR * Math.cos(a);
        const y = CONFIG.HOOP_Y + threeR * Math.sin(a);
        return [xScale(x), yScale(y)];
    });

    court.append('path')
        .attr('d', d3.line()(arcPoints));

    // Clickable Zones Layer
    zonesLayer = root.append('g')
        .attr('class', 'zones-layer')
        .style('cursor', 'pointer');

    drawClickableZones();

    // Create canvas for shots (layered on top of SVG, inside wrapper)
    const canvas = document.createElement('canvas');
    canvas.width = chartWidth;
    canvas.height = chartHeight;
    canvas.style.position = 'absolute';
    canvas.style.left = '0';
    canvas.style.top = '0';
    canvas.style.pointerEvents = 'none';
    wrapper.appendChild(canvas);

    ctx = canvas.getContext('2d');

    return { svg, canvas };
}

// ============================================
// Clickable Zones
// ============================================
function drawClickableZones() {
    const threeR = CONFIG.THREE_R;
    const corner = CONFIG.CORNER;
    const yBreak = CONFIG.Y_BREAK;
    const aL = CONFIG.ARC_LEFT;
    const aR = CONFIG.ARC_RIGHT;

    // Zone styling function
    function zoneStyles(sel) {
        sel
            .attr('fill', 'rgba(255,165,0,0.08)')
            .attr('stroke', 'rgba(0,0,0,0.15)')
            .attr('stroke-width', '1')
            .style('pointer-events', 'all')
            .on('mouseover', function() {
                d3.select(this).attr('fill', 'rgba(30, 136, 229, 0.25)');
                d3.select(this).attr('stroke', 'rgba(0,0,0,0.4)');
            })
            .on('mouseout', function() {
                d3.select(this).attr('fill', 'rgba(255,165,0,0.08)');
                d3.select(this).attr('stroke', 'rgba(0,0,0,0.15)');
            });
    }

    // Mid-Range Zone (excludes paint, inside 3-point line)
    function makeMidRangePath() {
        const outerPath = [];
        outerPath.push([-22, 0]);
        outerPath.push([-corner, 0]);
        outerPath.push([-corner, yBreak]);

        // 3-point arc
        const N = 200;
        for (let i = 0; i <= N; i++) {
            const t = i / N;
            const a = aL + (aR - aL) * t;
            outerPath.push([threeR * Math.cos(a), CONFIG.HOOP_Y + threeR * Math.sin(a)]);
        }

        outerPath.push([corner, yBreak]);
        outerPath.push([corner, 0]);
        outerPath.push([22, 0]);

        // Exclude paint
        const paintPath = [[-8, 0], [-8, 19], [8, 19], [8, 0]];
        paintPath.reverse();

        let pathStr = 'M' + outerPath.map(p => `${xScale(p[0])},${yScale(p[1])}`).join(' L') + ' Z';
        pathStr += ' M' + paintPath.map(p => `${xScale(p[0])},${yScale(p[1])}`).join(' L') + ' Z';

        return pathStr;
    }

    // Mid-Range
    zonesLayer.append('path')
        .attr('d', makeMidRangePath())
        .attr('fill-rule', 'evenodd')
        .call(zoneStyles)
        .on('click', (event) => selectZoneFromClick('Mid-Range', event));

    // In The Paint (Non-RA)
    zonesLayer.append('rect')
        .attr('x', xScale(-8))
        .attr('y', yScale(19))
        .attr('width', xScale(8) - xScale(-8))
        .attr('height', yScale(0) - yScale(19))
        .call(zoneStyles)
        .on('click', (event) => selectZoneFromClick('In The Paint (Non-RA)', event));

    // Restricted Area
    zonesLayer.append('circle')
        .attr('cx', xScale(0))
        .attr('cy', yScale(CONFIG.HOOP_Y))
        .attr('r', Math.abs(xScale(5) - xScale(0)))
        .call(zoneStyles)
        .on('click', (event) => selectZoneFromClick('Restricted Area', event));

    // Above the Break 3
    zonesLayer.append('path')
        .attr('d', (() => {
            const pts = [];
            const N = 200;
            pts.push([-corner, yBreak]);
            for (let i = 0; i <= N; i++) {
                const t = i / N;
                const a = aL + (aR - aL) * t;
                pts.push([threeR * Math.cos(a), CONFIG.HOOP_Y + threeR * Math.sin(a)]);
            }
            pts.push([corner, yBreak]);
            pts.push([25, yBreak]);
            pts.push([25, 47]);
            pts.push([-25, 47]);
            pts.push([-25, yBreak]);
            pts.push([-corner, yBreak]);
            return 'M' + pts.map(p => `${xScale(p[0])},${yScale(p[1])}`).join(' L') + ' Z';
        })())
        .attr('fill-rule', 'evenodd')
        .call(zoneStyles)
        .on('click', (event) => selectZoneFromClick('Above the Break 3', event));

    // Right Corner 3 (appears on left due to rotation)
    zonesLayer.append('rect')
        .attr('x', xScale(-25))
        .attr('y', yScale(yBreak))
        .attr('width', xScale(-corner) - xScale(-25))
        .attr('height', yScale(0) - yScale(yBreak))
        .call(zoneStyles)
        .on('click', (event) => selectZoneFromClick('Right Corner 3', event));

    // Left Corner 3 (appears on right due to rotation)
    zonesLayer.append('rect')
        .attr('x', xScale(corner))
        .attr('y', yScale(yBreak))
        .attr('width', xScale(25) - xScale(corner))
        .attr('height', yScale(0) - yScale(yBreak))
        .call(zoneStyles)
        .on('click', (event) => selectZoneFromClick('Left Corner 3', event));
}

function selectZoneFromClick(zoneName, event) {
    const zoneSelect = document.getElementById('zoneFilter');
    const isCtrlOrCmd = event && (event.ctrlKey || event.metaKey);

    if (isCtrlOrCmd) {
        // Toggle this zone in multi-select mode
        const zoneIndex = currentFilters.zones.indexOf(zoneName);
        if (zoneIndex > -1) {
            // Remove if already selected
            currentFilters.zones.splice(zoneIndex, 1);
        } else {
            // Add to selection
            currentFilters.zones.push(zoneName);
        }
    } else {
        // Single select - replace all with just this zone
        currentFilters.zones = [zoneName];
    }

    // Update the select element to match
    Array.from(zoneSelect.options).forEach(o => {
        o.selected = currentFilters.zones.includes(o.value);
    });

    updateVisualization();
    renderFilterSummary();
}

// ============================================
// Shot Rendering
// ============================================
function renderShots(data) {
    if (!ctx) return;

    ctx.clearRect(0, 0, chartWidth, chartHeight);
    ctx.globalAlpha = CONFIG.DOT_A;

    for (let i = 0; i < data.length; i++) {
        const d = data[i];

        // Convert to pixel coordinates
        const px = xScale(d._x);
        const py = yScale(d._y);

        // Apply 180 degree rotation (same as court)
        const rotatedX = 2 * CX - px;
        const rotatedY = 2 * CY - py;

        ctx.beginPath();
        ctx.arc(rotatedX, rotatedY, CONFIG.DOT_R, 0, Math.PI * 2);
        ctx.fillStyle = d._made ? 'green' : 'red';
        ctx.fill();
    }
}

// ============================================
// KPI Updates
// ============================================
function updateKPIs(data) {
    const totalShots = data.length;
    const madeShots = data.filter(d => d._made).length;
    const fg = totalShots ? madeShots / totalShots : 0;

    // Calculate league FG% for current season
    const seasonData = getSeasonData();
    const seasonMakes = seasonData.reduce((a, d) => a + (d._made ? 1 : 0), 0);
    leagueFg = seasonData.length ? seasonMakes / seasonData.length : 0;

    // 3PT stats
    const threePointers = data.filter(d => (d.SHOT_TYPE || '').includes('3PT'));
    const threesMade = threePointers.filter(d => d._made).length;
    const threePct = threePointers.length ? threesMade / threePointers.length : 0;
    const threePAR = totalShots ? threePointers.length / totalShots : 0;

    // eFG%
    const efg = totalShots ? (madeShots + 0.5 * threesMade) / totalShots : 0;

    // FG% vs league average
    const fgDiff = fg - leagueFg;

    // Update DOM
    animateKPI('kpi-shots', fmtInt(totalShots));
    animateKPI('kpi-makes', fmtInt(madeShots));
    animateKPI('kpi-fg', fmtPct(fg));
    animateKPI('kpi-3p', fmtPct(threePct));
    animateKPI('kpi-3pa-rate', fmtPct(threePAR));

    // eFG% - only show when no zone filter is active
    const efgEl = document.getElementById('kpi-efg');
    if (currentFilters.zones.length === 0) {
        efgEl.textContent = fmtPct(efg);
    } else {
        efgEl.textContent = '--';
    }

    // FG% difference with color
    const fgDiffEl = document.getElementById('kpi-fg-diff');
    fgDiffEl.textContent = fmtPctDiff(fgDiff);
    fgDiffEl.className = 'fw-bold ' + (fgDiff >= 0 ? 'fg-positive' : 'fg-negative');

    // Shot Distribution (2PT vs 3PT)
    const twoPtPct = 1 - threePAR;
    document.getElementById('kpi-2pt-pct').textContent = fmtPct(twoPtPct);
    document.getElementById('kpi-3pt-pct').textContent = fmtPct(threePAR);
    document.getElementById('progress-2pt').style.width = (twoPtPct * 100) + '%';
    document.getElementById('progress-3pt').style.width = (threePAR * 100) + '%';
}

function animateKPI(elementId, value) {
    const el = document.getElementById(elementId);
    if (el) {
        el.textContent = value;
        el.classList.add('updated');
        setTimeout(() => el.classList.remove('updated'), 300);
    }
}

function updateZoneBreakdown(data) {
    const zoneOrder = [
        'Restricted Area',
        'In The Paint (Non-RA)',
        'Mid-Range',
        'Left Corner 3',
        'Right Corner 3',
        'Above the Break 3'
    ];

    const zoneShortNames = {
        'Restricted Area': 'Restricted',
        'In The Paint (Non-RA)': 'Paint',
        'Mid-Range': 'Mid-Range',
        'Left Corner 3': 'L Corner 3',
        'Right Corner 3': 'R Corner 3',
        'Above the Break 3': 'Above Break 3'
    };

    // Calculate FG% by zone
    const zoneStats = {};
    zoneOrder.forEach(zone => {
        const zoneShots = data.filter(d => d._zone === zone);
        const made = zoneShots.filter(d => d._made).length;
        const total = zoneShots.length;
        zoneStats[zone] = total > 0 ? made / total : 0;
    });

    // Build HTML
    const container = document.getElementById('zoneBreakdown');
    container.innerHTML = zoneOrder.map(zone => `
        <div class="zone-item">
            <div class="zone-name">${zoneShortNames[zone]}</div>
            <div class="zone-fg">${fmtPct(zoneStats[zone])}</div>
        </div>
    `).join('');
}

// ============================================
// Filter Summary
// ============================================
function renderFilterSummary() {
    const pieces = [];

    if (currentFilters.season !== 'all') {
        pieces.push(`<strong>Season:</strong> ${currentFilters.season}`);
    }
    if (currentFilters.teams.length > 0) {
        pieces.push(`<strong>Team:</strong> ${currentFilters.teams.join(', ')}`);
    }
    if (currentFilters.players.length > 0) {
        pieces.push(`<strong>Player:</strong> ${currentFilters.players.join(', ')}`);
    }
    if (currentFilters.positions.length > 0) {
        const posLabels = currentFilters.positions.map(p => {
            if (p === 'G') return 'Guard';
            if (p === 'F') return 'Forward';
            if (p === 'C') return 'Center';
            return p;
        });
        pieces.push(`<strong>Position:</strong> ${posLabels.join(', ')}`);
    }
    if (currentFilters.zones.length > 0) {
        pieces.push(`<strong>Zone:</strong> ${currentFilters.zones.join(', ')}`);
    }
    if (currentFilters.shotResult !== 'all') {
        pieces.push(`<strong>Result:</strong> ${currentFilters.shotResult === 'made' ? 'Made' : 'Missed'}`);
    }

    const summaryEl = document.getElementById('filterSummary');
    if (pieces.length === 0) {
        summaryEl.innerHTML = 'None (all values included).';
    } else {
        summaryEl.innerHTML = pieces.join('<br>');
    }
}

// ============================================
// Filter Application
// ============================================
function applyFilters() {
    Object.values(dimensions).forEach(dim => {
        if (dim.filterAll) dim.filterAll();
    });

    // Season filter (skip if 'all')
    if (currentFilters.season !== 'all') {
        dimensions.season.filter(String(currentFilters.season));
    }

    // Team filter
    if (currentFilters.teams.length > 0) {
        const teamSet = new Set(currentFilters.teams);
        dimensions.team.filterFunction(d => teamSet.has(d));
    }

    // Position filter (checkbox-based: G, F, C)
    if (currentFilters.positions.length > 0) {
        dimensions.position.filterFunction(d => {
            const pos = (d || '').toUpperCase();
            return currentFilters.positions.some(p => {
                if (p === 'G') return pos.includes('G');
                if (p === 'F') return pos.includes('F');
                if (p === 'C') return pos === 'C' || pos.includes('CENTER');
                return true;
            });
        });
    }

    // Shot result filter
    if (currentFilters.shotResult === 'made') {
        dimensions.shotMade.filter(true);
    } else if (currentFilters.shotResult === 'missed') {
        dimensions.shotMade.filter(false);
    }

    // Player filter
    if (currentFilters.players.length > 0) {
        const playerSet = new Set(currentFilters.players);
        dimensions.player.filterFunction(d => playerSet.has(d));
    }

    // Zone filter
    if (currentFilters.zones.length > 0) {
        const zoneSet = new Set(currentFilters.zones);
        dimensions.zone.filterFunction(d => zoneSet.has(d));
    }

    return dimensions.all.top(Infinity);
}

// ============================================
// Cascading Filters
// ============================================
function updateCascadingFilters(changedFilter = null) {
    const filteredData = dimensions.all.top(Infinity);

    // Only update filters that don't have active selections
    if (changedFilter !== 'team' && currentFilters.teams.length === 0) {
        const teams = [...new Set(filteredData.map(d => d._team))].filter(Boolean).sort();
        populateSelect('teamFilter', teams, currentFilters.teams);
    }

    if (changedFilter !== 'player' && currentFilters.players.length === 0) {
        const players = [...new Set(filteredData.map(d => d._player))].filter(Boolean).sort();
        populateSelect('playerFilter', players, currentFilters.players);
    }

    if (changedFilter !== 'zone' && currentFilters.zones.length === 0) {
        const zones = [...new Set(filteredData.map(d => d._zone))].filter(Boolean).sort();
        populateSelect('zoneFilter', zones, currentFilters.zones);
    }
}

// ============================================
// Update Visualization
// ============================================
function updateVisualization() {
    const filteredData = applyFilters();
    renderShots(filteredData);
    updateKPIs(filteredData);
    updateZoneBreakdown(filteredData);
    renderFilterSummary();
}

// ============================================
// Event Handlers
// ============================================
function setupEventListeners() {
    const seasonSlider = document.getElementById('seasonSlider');
    const seasonLabel = document.getElementById('seasonLabel');
    const seasonDropdown = document.getElementById('seasonDropdown');

    // Season Slider: 0 = all, 1-21 = years 2004-2024
    const indexToYear = (idx) => idx === 0 ? 'all' : 2003 + idx;
    const yearToIndex = (year) => year === 'all' ? 0 : year - 2003;

    seasonSlider.addEventListener('input', function() {
        const idx = parseInt(this.value);
        const year = indexToYear(idx);

        if (year === 'all') {
            currentFilters.season = 'all';
            seasonLabel.textContent = 'All Seasons';
            seasonDropdown.value = 'all';
        } else {
            currentFilters.season = year;
            seasonLabel.textContent = year;
            seasonDropdown.value = year;
        }
        populateFilters();
        updateVisualization();
    });

    // Season Dropdown (synced with slider)
    seasonDropdown.addEventListener('change', function() {
        if (this.value === 'all') {
            currentFilters.season = 'all';
            seasonSlider.value = 0;
            seasonLabel.textContent = 'All Seasons';
        } else {
            const year = parseInt(this.value);
            currentFilters.season = year;
            seasonSlider.value = yearToIndex(year);
            seasonLabel.textContent = year;
        }
        populateFilters();
        updateVisualization();
    });

    // Play/Pause button
    document.getElementById('playBtn').addEventListener('click', function() {
        if (isPlaying) {
            stopPlayback();
        } else {
            startPlayback();
        }
    });

    // Speed selector
    document.getElementById('speedSelect').addEventListener('change', function() {
        CONFIG.AUTOPLAY_DELAY_MS = parseInt(this.value);
        if (isPlaying) {
            stopPlayback();
            startPlayback();
        }
    });

    // Team filter
    document.getElementById('teamFilter').addEventListener('change', function() {
        currentFilters.teams = Array.from(this.selectedOptions, opt => opt.value);
        applyFilters();
        updateCascadingFilters('team');
        updateVisualization();
    });

    // Position filter (checkboxes)
    document.querySelectorAll('#positionFilter input').forEach(input => {
        input.addEventListener('change', function() {
            if (this.value === 'all') {
                if (this.checked) {
                    currentFilters.positions = [];
                    document.querySelectorAll('#positionFilter input:not([value="all"])').forEach(i => i.checked = false);
                }
            } else {
                document.getElementById('pos-all').checked = false;
                currentFilters.positions = Array.from(
                    document.querySelectorAll('#positionFilter input:checked:not([value="all"])'),
                    i => i.value
                );
            }
            updateVisualization();
        });
    });

    // Shot result filter
    document.querySelectorAll('input[name="shotResult"]').forEach(input => {
        input.addEventListener('change', function() {
            currentFilters.shotResult = this.value;
            updateVisualization();
        });
    });

    // Player filter
    document.getElementById('playerFilter').addEventListener('change', function() {
        currentFilters.players = Array.from(this.selectedOptions, opt => opt.value);
        applyFilters();
        updateCascadingFilters('player');
        updateVisualization();
    });

    // Zone filter
    document.getElementById('zoneFilter').addEventListener('change', function() {
        currentFilters.zones = Array.from(this.selectedOptions, opt => opt.value);
        applyFilters();
        updateCascadingFilters('zone');
        updateVisualization();
    });

    // Search inputs
    document.getElementById('teamSearch').addEventListener('input', function() {
        filterSelectOptions('teamFilter', this.value);
    });

    document.getElementById('playerSearch').addEventListener('input', function() {
        filterSelectOptions('playerFilter', this.value);
    });

    document.getElementById('zoneSearch').addEventListener('input', function() {
        filterSelectOptions('zoneFilter', this.value);
    });

    // Individual clear buttons
    document.getElementById('clearTeam').addEventListener('click', function() {
        currentFilters.teams = [];
        document.getElementById('teamFilter').selectedIndex = -1;
        document.getElementById('teamSearch').value = '';
        filterSelectOptions('teamFilter', '');
        updateCascadingFilters('team');
        updateVisualization();
    });

    document.getElementById('clearPlayer').addEventListener('click', function() {
        currentFilters.players = [];
        document.getElementById('playerFilter').selectedIndex = -1;
        document.getElementById('playerSearch').value = '';
        filterSelectOptions('playerFilter', '');
        updateCascadingFilters('player');
        updateVisualization();
    });

    document.getElementById('clearZone').addEventListener('click', function() {
        currentFilters.zones = [];
        document.getElementById('zoneFilter').selectedIndex = -1;
        document.getElementById('zoneSearch').value = '';
        filterSelectOptions('zoneFilter', '');
        updateCascadingFilters('zone');
        updateVisualization();
    });

    // Clear all filters button
    document.getElementById('resetFilters').addEventListener('click', resetFilters);

    // Window resize
    let resizeTimeout;
    window.addEventListener('resize', function() {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(function() {
            drawCourt();
            updateVisualization();
        }, 250);
    });
}

function resetFilters() {
    currentFilters.season = 'all';
    currentFilters.teams = [];
    currentFilters.positions = [];
    currentFilters.players = [];
    currentFilters.zones = [];
    currentFilters.shotResult = 'all';

    // Reset season controls
    document.getElementById('seasonSlider').value = 0;
    document.getElementById('seasonLabel').textContent = 'All Seasons';
    document.getElementById('seasonDropdown').value = 'all';

    // Clear select elements
    ['teamFilter', 'playerFilter', 'zoneFilter'].forEach(id => {
        const select = document.getElementById(id);
        if (select) select.selectedIndex = -1;
    });

    // Clear search inputs
    ['teamSearch', 'playerSearch', 'zoneSearch'].forEach(id => {
        const input = document.getElementById(id);
        if (input) input.value = '';
    });

    // Reset filter option visibility
    filterSelectOptions('teamFilter', '');
    filterSelectOptions('playerFilter', '');
    filterSelectOptions('zoneFilter', '');

    // Reset position checkboxes
    document.getElementById('pos-all').checked = true;
    document.querySelectorAll('#positionFilter input:not([value="all"])').forEach(i => i.checked = false);

    // Reset shot result
    document.getElementById('shot-all').checked = true;

    stopPlayback();
    populateFilters();
    updateVisualization();
}

// ============================================
// Playback Controls
// ============================================
function startPlayback() {
    isPlaying = true;
    document.getElementById('playIcon').className = 'bi bi-pause-fill';

    const slider = document.getElementById('seasonSlider');
    let currentIdx = parseInt(slider.value);

    // Start from index 1 (year 2004) if on "all" (0) or at the end (21 = 2024)
    if (currentIdx === 0 || currentIdx >= 21) {
        currentIdx = 1;
        const year = 2004;
        slider.value = currentIdx;
        document.getElementById('seasonLabel').textContent = year;
        document.getElementById('seasonDropdown').value = year;
        currentFilters.season = year;
        populateFilters();
        updateVisualization();
    }

    playInterval = setInterval(() => {
        currentIdx++;
        if (currentIdx > 21) {
            stopPlayback();
            return;
        }
        const year = 2003 + currentIdx;
        slider.value = currentIdx;
        document.getElementById('seasonLabel').textContent = year;
        document.getElementById('seasonDropdown').value = year;
        currentFilters.season = year;
        populateFilters();
        updateVisualization();
    }, CONFIG.AUTOPLAY_DELAY_MS);
}

function stopPlayback() {
    isPlaying = false;
    document.getElementById('playIcon').className = 'bi bi-play-fill';
    if (playInterval) {
        clearInterval(playInterval);
        playInterval = null;
    }
}

// ============================================
// Initialization
// ============================================
async function init() {
    try {
        await loadData();
        setupCrossfilter(allData);
        populateFilters();
        drawCourt();
        setupEventListeners();
        updateVisualization();

        document.getElementById('loading-overlay').classList.add('hidden');
        console.log('NBA Shot Chart initialized successfully!');

    } catch (error) {
        console.error('Error initializing application:', error);
        document.getElementById('loading-overlay').innerHTML = `
            <div class="text-danger">
                <i class="bi bi-exclamation-triangle" style="font-size: 3rem;"></i>
                <div class="mt-3">Error loading data. Please check console for details.</div>
            </div>
        `;
    }
}

document.addEventListener('DOMContentLoaded', init);
