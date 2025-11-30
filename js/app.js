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
    AUTOPLAY_DELAY_MS: 600,
    playSpeed: 1000,

    // Seasons
    seasons: [
        '2004', '2005', '2006', '2007', '2008', '2009', '2010',
        '2011', '2012', '2013', '2014', '2015', '2016', '2017',
        '2018', '2019', '2020', '2021', '2022', '2023', '2024'
    ]
};

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
    season: null,
    teams: [],
    positions: [],
    players: [],
    zones: [],
    shotResult: 'all'
};
let isPlaying = false;
let playInterval = null;
let leagueFg = 0;

// Chart elements
let chartWidth, chartHeight, xScale, yScale, ctx, CX, CY;

// ============================================
// Utility Functions
// ============================================
const toFeet = (v) => {
    const n = +v;
    return Math.abs(n) > 60 ? n / 10 : n;
};

const fmtInt = (n) => n.toLocaleString();
const fmtPct = (v) => (v * 100).toFixed(1) + '%';

// ============================================
// Data Loading
// ============================================
async function loadData() {
    const loadingProgress = document.getElementById('loading-progress');

    try {
        const rawData = await d3.csv('data/nba_shots_sampled.csv');
        loadingProgress.style.width = '100%';

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
                _zone: d.BASIC_ZONE || '',
                SEASON_1: String(year),
                LOC_X: +d.LOC_X,
                LOC_Y: +d.LOC_Y,
                SHOT_DISTANCE: +d.SHOT_DISTANCE
            };
        }).filter(d => d._pos && d._pos.trim() !== '');

        // Calculate league average FG%
        const leagueMakes = allData.reduce((a, d) => a + (d._made ? 1 : 0), 0);
        leagueFg = allData.length ? leagueMakes / allData.length : 0;

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
    const teams = [...new Set(allData.map(d => d._team))].filter(Boolean).sort();
    const players = [...new Set(allData.map(d => d._player))].filter(Boolean).sort();
    const zones = [...new Set(allData.map(d => d._zone))].filter(Boolean).sort();

    document.getElementById('teamFilter').innerHTML = teams.map(t => `<option value="${t}">${t}</option>`).join('');
    document.getElementById('playerFilter').innerHTML = players.map(p => `<option value="${p}">${p}</option>`).join('');
    document.getElementById('zoneFilter').innerHTML = zones.map(z => `<option value="${z}">${z}</option>`).join('');
}

// ============================================
// Court Drawing
// ============================================
function drawCourt() {
    const container = document.getElementById('court-container');
    const containerWidth = container.clientWidth;

    // Calculate dimensions
    chartWidth = Math.min(containerWidth - 20, 680);
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
    const threeR = 23.75;
    const corner = 22;
    const yBreak = CONFIG.HOOP_Y + Math.sqrt(threeR * threeR - corner * corner);

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
    const theta = Math.acos(corner / threeR);
    const aL = Math.PI - theta;
    const aR = theta;
    const arcPoints = d3.range(0, 1.0001, 1 / 160).map(t => {
        const a = aL + (aR - aL) * t;
        const x = threeR * Math.cos(a);
        const y = CONFIG.HOOP_Y + threeR * Math.sin(a);
        return [xScale(x), yScale(y)];
    });

    court.append('path')
        .attr('d', d3.line()(arcPoints));

    // Create canvas for shots (layered on top of SVG, inside wrapper)
    const canvas = document.createElement('canvas');
    canvas.width = chartWidth;
    canvas.height = chartHeight;
    canvas.style.position = 'absolute';
    canvas.style.left = '0';
    canvas.style.top = '0';
    canvas.style.pointerEvents = 'none';
    wrapper.appendChild(canvas);  // Append to wrapper, not container

    ctx = canvas.getContext('2d');

    return { svg, canvas };
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

    // 3PT stats
    const threePointers = data.filter(d => (d.SHOT_TYPE || '').includes('3PT'));
    const threesMade = threePointers.filter(d => d._made).length;
    const threePct = threePointers.length ? threesMade / threePointers.length : 0;
    const threePAR = totalShots ? threePointers.length / totalShots : 0;

    // eFG%
    const efg = totalShots ? (madeShots + 0.5 * threesMade) / totalShots : 0;

    // 2PT distribution
    const twoPointers = data.filter(d => (d.SHOT_TYPE || '').includes('2PT'));
    const twoPtPct = totalShots ? twoPointers.length / totalShots : 0;

    // FG% vs league average
    const fgDiff = fg - leagueFg;

    // Update DOM
    animateKPI('kpi-shots', fmtInt(totalShots));
    animateKPI('kpi-fg', fmtPct(fg));
    animateKPI('kpi-3p', fmtPct(threePct));
    animateKPI('kpi-efg', fmtPct(efg));

    document.getElementById('kpi-2pt-pct').textContent = fmtPct(twoPtPct);
    document.getElementById('kpi-3pt-pct').textContent = fmtPct(threePAR);
    document.getElementById('progress-2pt').style.width = `${twoPtPct * 100}%`;
    document.getElementById('progress-3pt').style.width = `${threePAR * 100}%`;
}

function animateKPI(elementId, value) {
    const el = document.getElementById(elementId);
    el.textContent = value;
    el.classList.add('updated');
    setTimeout(() => el.classList.remove('updated'), 300);
}

// ============================================
// Filter Application
// ============================================
function applyFilters() {
    Object.values(dimensions).forEach(dim => {
        if (dim.filterAll) dim.filterAll();
    });

    if (currentFilters.season !== null) {
        const seasonYear = CONFIG.seasons[currentFilters.season];
        dimensions.season.filter(seasonYear);
    }

    if (currentFilters.teams.length > 0) {
        const teamSet = new Set(currentFilters.teams);
        dimensions.team.filterFunction(d => teamSet.has(d));
    }

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

    if (currentFilters.players.length > 0) {
        const playerSet = new Set(currentFilters.players);
        dimensions.player.filterFunction(d => playerSet.has(d));
    }

    if (currentFilters.zones.length > 0) {
        const zoneSet = new Set(currentFilters.zones);
        dimensions.zone.filterFunction(d => zoneSet.has(d));
    }

    if (currentFilters.shotResult === 'made') {
        dimensions.shotMade.filter(true);
    } else if (currentFilters.shotResult === 'missed') {
        dimensions.shotMade.filter(false);
    }

    return dimensions.all.top(Infinity);
}

// ============================================
// Update Visualization
// ============================================
function updateVisualization() {
    const filteredData = applyFilters();
    renderShots(filteredData);
    updateKPIs(filteredData);
}

// ============================================
// Event Handlers
// ============================================
function setupEventListeners() {
    const seasonSlider = document.getElementById('seasonSlider');
    const seasonLabel = document.getElementById('seasonLabel');

    seasonSlider.addEventListener('input', function() {
        const value = parseInt(this.value);
        if (value === 0) {
            currentFilters.season = null;
            seasonLabel.textContent = 'All Seasons';
        } else {
            currentFilters.season = value - 1;
            seasonLabel.textContent = `${CONFIG.seasons[value - 1]}-${String(parseInt(CONFIG.seasons[value - 1]) + 1).slice(-2)}`;
        }
        updateVisualization();
    });

    document.getElementById('playBtn').addEventListener('click', function() {
        if (isPlaying) {
            stopPlayback();
        } else {
            startPlayback();
        }
    });

    document.getElementById('speedSelect').addEventListener('change', function() {
        CONFIG.playSpeed = parseInt(this.value);
        if (isPlaying) {
            stopPlayback();
            startPlayback();
        }
    });

    document.getElementById('teamFilter').addEventListener('change', function() {
        currentFilters.teams = Array.from(this.selectedOptions, opt => opt.value);
        updatePlayerFilter();
        updateVisualization();
    });

    document.querySelectorAll('#positionFilter input').forEach(input => {
        input.addEventListener('change', function() {
            if (this.value === 'all') {
                currentFilters.positions = [];
                document.querySelectorAll('#positionFilter input:not([value="all"])').forEach(i => i.checked = false);
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

    document.getElementById('playerFilter').addEventListener('change', function() {
        currentFilters.players = Array.from(this.selectedOptions, opt => opt.value);
        updateVisualization();
    });

    document.getElementById('zoneFilter').addEventListener('change', function() {
        currentFilters.zones = Array.from(this.selectedOptions, opt => opt.value);
        updateVisualization();
    });

    document.querySelectorAll('input[name="shotResult"]').forEach(input => {
        input.addEventListener('change', function() {
            currentFilters.shotResult = this.value;
            updateVisualization();
        });
    });

    document.getElementById('resetFilters').addEventListener('click', resetFilters);

    document.getElementById('resetZoom').addEventListener('click', function() {
        drawCourt();
        updateVisualization();
    });

    let resizeTimeout;
    window.addEventListener('resize', function() {
        clearTimeout(resizeTimeout);
        resizeTimeout = setTimeout(function() {
            drawCourt();
            updateVisualization();
        }, 250);
    });
}

function updatePlayerFilter() {
    let relevantData = allData;
    if (currentFilters.teams.length > 0) {
        relevantData = allData.filter(d => currentFilters.teams.includes(d._team));
    }

    const players = [...new Set(relevantData.map(d => d._player))].filter(Boolean).sort();
    const playerSelect = document.getElementById('playerFilter');
    const currentSelections = currentFilters.players;

    playerSelect.innerHTML = players.map(p => {
        const selected = currentSelections.includes(p) ? 'selected' : '';
        return `<option value="${p}" ${selected}>${p}</option>`;
    }).join('');
}

function resetFilters() {
    currentFilters = {
        season: null,
        teams: [],
        positions: [],
        players: [],
        zones: [],
        shotResult: 'all'
    };

    document.getElementById('seasonSlider').value = 0;
    document.getElementById('seasonLabel').textContent = 'All Seasons';
    document.getElementById('teamFilter').selectedIndex = -1;
    document.getElementById('playerFilter').selectedIndex = -1;
    document.getElementById('zoneFilter').selectedIndex = -1;
    document.getElementById('pos-all').checked = true;
    document.querySelectorAll('#positionFilter input:not([value="all"])').forEach(i => i.checked = false);
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
    let currentValue = parseInt(slider.value);

    if (currentValue >= 21) {
        currentValue = 0;
        slider.value = currentValue;
    }

    playInterval = setInterval(() => {
        currentValue++;
        if (currentValue > 21) {
            stopPlayback();
            return;
        }
        slider.value = currentValue;
        slider.dispatchEvent(new Event('input'));
    }, CONFIG.playSpeed);
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