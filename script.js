'use strict';

window.addEventListener('load', () => {

    // A. CONSTANTS & TUNING
    // =========================================================================
    const PPM = 60; // Pixels Per Meter
    const PHYSICS_STEP = 1 / 120; // 120 Hz physics simulation
    const MAX_ACCUMULATOR_STEPS = 5;

    // == VEHICLE PARAMETERS (ADJUSTED FOR STABILITY AND FEEL) ==
    const VEHICLE_PARAMS = {
        CHASSIS_MASS: 120, // kg
        REAR_BAR_DIM: { w: 1.2, h: 0.25 },
        FRONT_BAR_DIM: { w: 0.8, h: 0.25 },
        FRONT_BAR_OFFSET: { x: 0.8, y: -0.05 },
        WHEEL_MASS: 12, // kg
        WHEEL_RADIUS: 0.35, // m
        WHEEL_FRICTION: 1.5,
        WHEEL_RESTITUTION: 0.1,
        TRACK_WIDTH: 1.5,
        
        SUSPENSION_FREQ_HZ: 4.0, 
        SUSPENSION_DAMPING_RATIO: 1.2,
        SUSPENSION_TRAVEL: 0.20,
        MAX_SPRING_FORCE: 50000, 

        MOTOR_TORQUE: 550, // N·m
        MOTOR_MAX_SPEED: 55, // rad/s
        BRAKE_TORQUE: 1200, // N·m
        ENGINE_BRAKE_TORQUE: 50, // N·m
        
        // [FIX] Increased air control torque for faster spinning
        AIR_CONTROL_TORQUE: 300, // N·m
        AIR_CONTROL_DAMPING: 80,
        
        SELF_RIGHTING_TORQUE: 400,
        AERIAL_STABILITY_TORQUE: 50,
    };

    const TERRAIN_PARAMS = { SEGMENT_LENGTH: 100, SAMPLE_DISTANCE: 0.8, MAX_SLOPE: 0.8, GENERATION_THRESHOLD: 200, CULLING_THRESHOLD: 150, FRICTION: 0.9, RESTITUTION: 0.0, A1: 0.8, F1: 0.4, P1: 0, A2: 0.3, F2: 1.2, P2: 0, };
    const GAME_PARAMS = { FUEL_START: 100, FUEL_DRAIN_RATE: 0.5, FUEL_DRAIN_THROTTLE_MULTIPLIER: 4.0, CHECKPOINT_DISTANCE: 150, FUEL_CAN_DISTANCE: 200, };

    // B. MATH & UTILITY HELPERS
    const clamp = (val, min, max) => Math.max(min, Math.min(val, max));
    const lerp = (a, b, t) => a * (1 - t) + b * t;
    const smoothFollow = (current, target, k, dt) => lerp(current, target, 1 - Math.exp(-k * dt));

    // C. GAME STATE & WORLD SETUP
    const canvas = document.getElementById('game-canvas');
    const ctx = canvas.getContext('2d');
    let world, vehicle, terrainManager, camera;
    let particles = [];
    let gameState = { paused: false, debug: false, gameOver: false, distance: 0, fuel: GAME_PARAMS.FUEL_START, lastCheckpoint: null, };
    const pl = planck, Vec2 = pl.Vec2;

    function initWorld() {
        world = pl.World({ gravity: Vec2(0, -10) });
        world.on('begin-contact', (c) => handleContact(c, true));
        world.on('end-contact', (c) => handleContact(c, false));
    }
    
    function handleContact(contact, isBeginning) {
        const getContactData = (fixture) => {
            if (!fixture) return null; let data = fixture.getUserData(); if (data) return data; const body = fixture.getBody(); if (!body) return null; return body.getUserData() || null;
        };
        const dataA = getContactData(contact.getFixtureA()); const dataB = getContactData(contact.getFixtureB()); if (!dataA || !dataB) return;
        const checkPair = (d1, d2, fix2) => {
            if (d1.type === 'wheel' && d2.type === 'ground') d1.owner.setGrounded(d1.wheelId, isBeginning);
            if (d1.type === 'chassis' && d2.type === 'checkpoint' && isBeginning) { gameState.lastCheckpoint = { pos: vehicle.chassis.getPosition(), angle: vehicle.chassis.getAngle(), linearVel: vehicle.chassis.getLinearVelocity(), angularVel: vehicle.chassis.getAngularVelocity() }; world.destroyBody(fix2.getBody()); }
            if (d1.type === 'chassis' && d2.type === 'fuel' && isBeginning) { gameState.fuel = Math.min(GAME_PARAMS.FUEL_START, gameState.fuel + 50); world.destroyBody(fix2.getBody()); }
        };
        checkPair(dataA, dataB, contact.getFixtureB()); checkPair(dataB, dataA, contact.getFixtureB());
    }

    function resizeCanvas() { const dpr = window.devicePixelRatio || 1; const rect = canvas.getBoundingClientRect(); canvas.width = rect.width * dpr; canvas.height = rect.height * dpr; ctx.scale(dpr, dpr); }
    
    // D. INPUT MANAGER
    const input = {
        throttle: 0, brake: 0, pitch: 0, keys: new Set(),
        init() {
            window.addEventListener('keydown', e => this.keys.add(e.code));
            window.addEventListener('keyup', e => { this.keys.delete(e.code); if (e.code === 'KeyR') this.handleReset(); if (e.code === 'Space') gameState.paused = !gameState.paused; if (e.code === 'KeyH') document.getElementById('help-panel').classList.toggle('hidden'); if (e.code === 'KeyD') gameState.debug = !gameState.debug; });
            const setupMobileBtn = (id, action) => { const btn = document.getElementById(id); btn.addEventListener('touchstart', (e) => { e.preventDefault(); action(1); }, { passive: false }); btn.addEventListener('touchend', (e) => { e.preventDefault(); action(0); }, { passive: false }); };
            setupMobileBtn('throttle-btn', v => this.throttle = v); setupMobileBtn('brake-btn', v => this.brake = v); setupMobileBtn('tilt-forward-btn', v => this.pitch = v); setupMobileBtn('tilt-backward-btn', v => this.pitch = -v);
        },
        update() { this.throttle = this.keys.has('ArrowUp') ? 1 : 0; this.brake = this.keys.has('ArrowDown') ? 1 : 0; this.pitch = (this.keys.has('ArrowRight') ? 1 : 0) - (this.keys.has('ArrowLeft') ? 1 : 0); const gp = navigator.getGamepads ? navigator.getGamepads()[0] : null; if (gp) { this.throttle = Math.max(this.throttle, gp.buttons[7].value); this.brake = Math.max(this.brake, gp.buttons[6].value); if (Math.abs(gp.axes[0]) > 0.15) this.pitch = gp.axes[0]; if (gp.buttons[9].pressed) gameState.paused = !gameState.paused; } },
        handleReset() { if (gameState.lastCheckpoint) { vehicle.reset(gameState.lastCheckpoint.pos, gameState.lastCheckpoint.angle, gameState.lastCheckpoint.linearVel, gameState.lastCheckpoint.angularVel); gameState.fuel = Math.max(25, gameState.fuel); } else { vehicle.reset(Vec2(4, 5), 0, Vec2.zero(), 0); gameState.fuel = GAME_PARAMS.FUEL_START; } gameState.gameOver = false; document.getElementById('game-over-panel').classList.add('hidden'); }
    };

    // E. TERRAIN MANAGER
    function createTerrainManager() {
        let bodies = [], lastGeneratedX = 0; const seed = Math.random() * 1000; TERRAIN_PARAMS.P1 = seed; TERRAIN_PARAMS.P2 = seed + 100;
        const getHeight = x => TERRAIN_PARAMS.A1 * Math.sin(TERRAIN_PARAMS.F1 * x + TERRAIN_PARAMS.P1) + TERRAIN_PARAMS.A2 * Math.sin(TERRAIN_PARAMS.F2 * x + TERRAIN_PARAMS.P2);
        const generateSegment = (startX) => {
            const points = []; let lastY = getHeight(startX); points.push(Vec2(startX, lastY));
            for (let x = startX + TERRAIN_PARAMS.SAMPLE_DISTANCE; x <= startX + TERRAIN_PARAMS.SEGMENT_LENGTH; x += TERRAIN_PARAMS.SAMPLE_DISTANCE) {
                let y = getHeight(x); const slope = (y - lastY) / TERRAIN_PARAMS.SAMPLE_DISTANCE; if (Math.abs(slope) > TERRAIN_PARAMS.MAX_SLOPE) y = lastY + Math.sign(slope) * TERRAIN_PARAMS.MAX_SLOPE * TERRAIN_PARAMS.SAMPLE_DISTANCE; points.push(Vec2(x, y)); lastY = y;
            }
            const body = world.createBody(Vec2.zero()); body.createFixture(pl.Chain(points, false), { friction: TERRAIN_PARAMS.FRICTION, restitution: TERRAIN_PARAMS.RESTITUTION, userData: { type: 'ground' } }); bodies.push({body: body, startX: startX, endX: startX + TERRAIN_PARAMS.SEGMENT_LENGTH}); lastGeneratedX = startX + TERRAIN_PARAMS.SEGMENT_LENGTH;
            for(let i = 1; i < points.length - 1; i++) {
                if (points[i].y > points[i-1].y && points[i].y > points[i+1].y) {
                    const x = points[i].x; if (x > (terrainManager.lastCheckpointX + GAME_PARAMS.CHECKPOINT_DISTANCE)) { createCollectible(Vec2(x, points[i].y + 1.5), 'checkpoint'); terrainManager.lastCheckpointX = x; } if (x > (terrainManager.lastFuelX + GAME_PARAMS.FUEL_CAN_DISTANCE)) { createCollectible(Vec2(x, points[i].y + 1.5), 'fuel'); terrainManager.lastFuelX = x; }
                }
            }
        };
        return {
            init() { this.lastCheckpointX = 0; this.lastFuelX = 0; generateSegment(-TERRAIN_PARAMS.SEGMENT_LENGTH); generateSegment(0); },
            update(cameraX) { if (cameraX > lastGeneratedX - TERRAIN_PARAMS.GENERATION_THRESHOLD) generateSegment(lastGeneratedX); if (bodies.length > 0 && cameraX > bodies[0].endX + TERRAIN_PARAMS.CULLING_THRESHOLD) { world.destroyBody(bodies[0].body); bodies.shift(); } },
            getSlope(x) { let normal = Vec2(0, 1); world.rayCast(Vec2(x, 50), Vec2(x, -50), (fixture, point, n) => { const userData = fixture.getUserData(); if (userData && userData.type === 'ground') { normal = n; return 0; } return -1; }); return -normal.x / normal.y; }
        };
    }
    function createCollectible(pos, type) { const body = world.createBody({ type: 'static', position: pos }); body.createFixture(pl.Box(0.5, 0.5), { isSensor: true, userData: { type: type } }); body.renderData = { type }; }

    // F. VEHICLE FACTORY
    function createVehicle(world, pos) {
        const { CHASSIS_MASS, REAR_BAR_DIM, FRONT_BAR_DIM, FRONT_BAR_OFFSET, WHEEL_MASS, WHEEL_RADIUS, TRACK_WIDTH, WHEEL_FRICTION } = VEHICLE_PARAMS;

        const chassis = world.createDynamicBody({ position: pos, angularDamping: 0.1 });
        const density = CHASSIS_MASS / ((REAR_BAR_DIM.w * REAR_BAR_DIM.h) + (FRONT_BAR_DIM.w * FRONT_BAR_DIM.h));
        const chassisFixtureDef = { density, filterGroupIndex: -1 };
        chassis.createFixture(pl.Box(REAR_BAR_DIM.w / 2, REAR_BAR_DIM.h / 2, Vec2(-0.2, 0)), chassisFixtureDef);
        chassis.createFixture(pl.Box(FRONT_BAR_DIM.w / 2, FRONT_BAR_DIM.h / 2, Vec2(FRONT_BAR_OFFSET.x, FRONT_BAR_OFFSET.y)), chassisFixtureDef);
        chassis.setUserData({ type: 'chassis' });

        const wheelFixtureDef = { density: WHEEL_MASS / (Math.PI * WHEEL_RADIUS * WHEEL_RADIUS), friction: WHEEL_FRICTION, restitution: VEHICLE_PARAMS.WHEEL_RESTITUTION, filterGroupIndex: -1, };
        
        const rearWheelAnchor = Vec2(-TRACK_WIDTH / 2, -1.0); const frontWheelAnchor = Vec2(TRACK_WIDTH / 2, -1.0);

        const createWheelAssembly = (wheelId, localAnchorOnChassis) => {
            const worldPos = chassis.getWorldPoint(localAnchorOnChassis); const wheel = world.createDynamicBody({ position: worldPos, bullet: true }); wheel.createFixture(pl.Circle(WHEEL_RADIUS), { ...wheelFixtureDef, userData: { type: 'wheel', wheelId: wheelId, owner: null } }); const suspension = world.createJoint(pl.PrismaticJoint({ localAnchorA: localAnchorOnChassis, localAnchorB: Vec2.zero(), localAxisA: Vec2(0, 1), enableLimit: true, lowerTranslation: -VEHICLE_PARAMS.SUSPension_TRAVEL, upperTranslation: VEHICLE_PARAMS.SUSPENSION_TRAVEL, }, chassis, wheel)); return { wheel, suspension };
        };

        const rearAssembly = createWheelAssembly('rear', rearWheelAnchor); const frontAssembly = createWheelAssembly('front', frontWheelAnchor);

        const vehicleObj = {
            chassis, rearWheel: rearAssembly.wheel, frontWheel: frontAssembly.wheel,
            rearSuspension: rearAssembly.suspension, frontSuspension: frontAssembly.suspension,
            groundContactCount: { rear: 0, front: 0 },
            airControlTorque: 0,
            totalAppliedTorque: 0, // [NEW] For HUD display
            
            get isRearGrounded() { return this.groundContactCount.rear > 0; },
            get isFrontGrounded() { return this.groundContactCount.front > 0; },

            setGrounded(wheelId, isGrounded) { this.groundContactCount[wheelId] += isGrounded ? 1 : -1; },

            reset(pos, angle, linearVel, angularVel) {
                this.chassis.setPosition(pos); this.chassis.setAngle(angle); this.chassis.setLinearVelocity(linearVel || Vec2.zero()); this.chassis.setAngularVelocity(angularVel || 0); this.rearWheel.setPosition(chassis.getWorldPoint(rearWheelAnchor)); this.frontWheel.setPosition(chassis.getWorldPoint(frontWheelAnchor)); this.rearWheel.setLinearVelocity(linearVel || Vec2.zero()); this.frontWheel.setLinearVelocity(linearVel || Vec2.zero()); this.rearWheel.setAngularVelocity(0); this.frontWheel.setAngularVelocity(0);
            },

            update(dt, input) {
                
                // --- 1. SUSPENSION PHYSICS ---
                const updateSuspension = (suspensionJoint, wheel) => {
                    const { SUSPENSION_FREQ_HZ, SUSPENSION_DAMPING_RATIO, MAX_SPRING_FORCE, CHASSIS_MASS, WHEEL_MASS } = VEHICLE_PARAMS; const m_eff = (CHASSIS_MASS / 2) + WHEEL_MASS; const omega = 2 * Math.PI * SUSPENSION_FREQ_HZ; const k = omega * omega * m_eff; const c = 2 * SUSPENSION_DAMPING_RATIO * omega * m_eff; const x = suspensionJoint.getJointTranslation(); const v = suspensionJoint.getJointSpeed(); let forceMag = -k * x - c * v; forceMag = clamp(forceMag, -MAX_SPRING_FORCE, MAX_SPRING_FORCE); const axis = this.chassis.getWorldVector(Vec2(0, 1)); const force = axis.mul(forceMag); const wheelPos = wheel.getPosition(); wheel.applyForce(force, wheelPos, true); this.chassis.applyForce(force.mul(-1), this.chassis.getWorldPoint(suspensionJoint.m_localAnchorA), true);
                };
                updateSuspension(this.rearSuspension, this.rearWheel); updateSuspension(this.frontSuspension, this.frontWheel);

                // --- 2. ENGINE AND BRAKING PHYSICS ---
                const { MOTOR_TORQUE, MOTOR_MAX_SPEED, BRAKE_TORQUE, ENGINE_BRAKE_TORQUE, WHEEL_RADIUS } = VEHICLE_PARAMS;
                let effectiveMotorTorque = MOTOR_TORQUE; if (this.isRearGrounded && input.throttle > 0) { const omega = this.rearWheel.getAngularVelocity(); const vx = this.chassis.getLinearVelocity().x; const tangentialSpeed = -omega * WHEEL_RADIUS; const slipRatio = (tangentialSpeed - vx) / Math.max(Math.abs(vx), 0.1); effectiveMotorTorque = MOTOR_TORQUE * (1 - 0.3 * clamp(Math.abs(slipRatio), 0, 1)); if (Math.abs(slipRatio) > 0.3) { const wheelPos = this.rearWheel.getPosition(); const particlePos = Vec2(wheelPos.x, wheelPos.y - WHEEL_RADIUS); const particleVel = this.chassis.getLinearVelocity().clone().mul(0.2); particleVel.x -= slipRatio * 1.5; spawnParticle(particlePos, particleVel, 0.7, '150,150,150'); } }
                let rearTorque = 0; const rearOmega = this.rearWheel.getAngularVelocity(); if (input.brake > 0 && this.isRearGrounded) { rearTorque = clamp(-rearOmega * 100, -BRAKE_TORQUE, BRAKE_TORQUE); } else if (input.throttle > 0) { if (rearOmega > -MOTOR_MAX_SPEED) { rearTorque = -effectiveMotorTorque; } } else if (this.isRearGrounded) { rearTorque = clamp(-rearOmega * 10, -ENGINE_BRAKE_TORQUE, ENGINE_BRAKE_TORQUE); } this.rearWheel.applyTorque(rearTorque, true);
                let frontTorque = 0; const frontOmega = this.frontWheel.getAngularVelocity(); if (input.brake > 0 && this.isFrontGrounded) { frontTorque = clamp(-frontOmega * 100, -BRAKE_TORQUE, BRAKE_TORQUE); } this.frontWheel.applyTorque(frontTorque, true);

                // --- 3. AERIAL ROTATION & STABILITY (REVISED LOGIC) ---
                let totalRotationalTorque = 0;
                const isInAir = !this.isRearGrounded && !this.isFrontGrounded;

                if (isInAir) {
                    // Part A: Player Input
                    const { AIR_CONTROL_TORQUE, AIR_CONTROL_DAMPING } = VEHICLE_PARAMS;
                    const targetTorque = -input.pitch * AIR_CONTROL_TORQUE;
                    this.airControlTorque = smoothFollow(this.airControlTorque, targetTorque, 5, dt);
                    totalRotationalTorque += this.airControlTorque;
                    
                    // Part B: Damping (slows existing rotation)
                    const currentOmega = this.chassis.getAngularVelocity();
                    totalRotationalTorque -= currentOmega * AIR_CONTROL_DAMPING;

                    // Part C: Self-Righting and Stability Assist
                    const { SELF_RIGHTING_TORQUE, AERIAL_STABILITY_TORQUE } = VEHICLE_PARAMS;
                    const upVector = this.chassis.getWorldVector(Vec2(0, 1));
                    const torqueToApply = upVector.y < 0 ? SELF_RIGHTING_TORQUE : AERIAL_STABILITY_TORQUE;
                    
                    // [FIX] The scaling factor makes the force stronger the more upside-down the car is.
                    // (1 - upVector.y) = 0 when upright, 1 on its side, 2 when fully upside down.
                    const scalingFactor = 1.0 - upVector.y;
                    
                    const correctionTorque = -upVector.x * torqueToApply * scalingFactor;
                    totalRotationalTorque += correctionTorque;
                } else {
                    this.airControlTorque = 0;
                }

                // Apply all calculated rotational forces at once
                this.chassis.applyTorque(totalRotationalTorque, true);
                this.totalAppliedTorque = totalRotationalTorque; // Store for HUD
            }
        };
        rearAssembly.wheel.getFixtureList().getUserData().owner = vehicleObj; frontAssembly.wheel.getFixtureList().getUserData().owner = vehicleObj; return vehicleObj;
    }

    // G. CAMERA
    function createCamera() { return { x: 0, y: 0, zoom: 1.0, update(dt, targetBody) { const targetPos = targetBody.getPosition(); const targetVel = targetBody.getLinearVelocity(); const lookahead = Vec2(targetVel.x * 0.4, targetVel.y * 0.2); const finalTarget = targetPos.clone().add(lookahead).add(Vec2(2, 1)); this.x = smoothFollow(this.x, finalTarget.x, 3, dt); this.y = smoothFollow(this.y, finalTarget.y, 3, dt); } }; }
    
    // H. PARTICLE SYSTEM
    function spawnParticle(pos, vel, lifetime, color) { particles.push({ pos, vel, lifetime, maxLifetime: lifetime, color }); }
    function updateAndRenderParticles(dt, ctx) { for (let i = particles.length - 1; i >= 0; i--) { const p = particles[i]; p.pos.add(p.vel.mul(dt)); p.vel.y -= 20 * dt; p.lifetime -= dt; if (p.lifetime <= 0) particles.splice(i, 1); else { const a = p.lifetime / p.maxLifetime; ctx.fillStyle = `rgba(${p.color}, ${a})`; ctx.fillRect(p.pos.x, p.pos.y, 0.1, 0.1); } } }

    // I. UI / HUD
    const hud = {
        speed: document.getElementById('speed-value'),
        rpm: document.getElementById('rpm-value'),
        fuel: document.getElementById('fuel-value'),
        distance: document.getElementById('distance-value'),
        slope: document.getElementById('slope-value'),
        gameOverPanel: document.getElementById('game-over-panel'),
        // [NEW] Get new HUD elements
        angle: document.getElementById('angle-value'),
        torque: document.getElementById('torque-value'),
        update() {
            const chassisPos = vehicle.chassis.getPosition();
            const linearVel = vehicle.chassis.getLinearVelocity().length();
            const rpm = Math.abs(vehicle.rearWheel.getAngularVelocity() * 60 / (2 * Math.PI));
            const slope = terrainManager.getSlope(chassisPos.x);
            gameState.distance = Math.max(gameState.distance, chassisPos.x);
            this.speed.textContent = (linearVel * 3.6).toFixed(0);
            this.rpm.textContent = rpm.toFixed(0);
            this.fuel.textContent = gameState.fuel.toFixed(0);
            this.distance.textContent = gameState.distance.toFixed(1);
            this.slope.textContent = (slope * 100).toFixed(0);

            // [NEW] Update new HUD values
            const angleDegrees = (vehicle.chassis.getAngle() * 180 / Math.PI) % 360;
            this.angle.textContent = angleDegrees.toFixed(0);
            this.torque.textContent = vehicle.totalAppliedTorque.toFixed(0);
            
            if(gameState.gameOver) this.gameOverPanel.classList.remove('hidden');
        }
    };
    
    // J. RENDERING
    function render() { const { width, height } = canvas; const dpr = window.devicePixelRatio || 1; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); const skyGradient = ctx.createLinearGradient(0, 0, 0, height); skyGradient.addColorStop(0, '#4b759e'); skyGradient.addColorStop(1, '#9cd2f2'); ctx.fillStyle = skyGradient; ctx.fillRect(0, 0, width, height); ctx.save(); ctx.translate(width / 2 / dpr, height / 2 / dpr); ctx.scale(PPM * camera.zoom, -PPM * camera.zoom); ctx.translate(-camera.x, -camera.y); for (let body = world.getBodyList(); body; body = body.getNext()) { const pos = body.getPosition(); const angle = body.getAngle(); ctx.save(); ctx.translate(pos.x, pos.y); ctx.rotate(angle); if (body.renderData && body.renderData.type === 'checkpoint') { ctx.fillStyle = 'gold'; ctx.fillRect(-0.25, -1, 0.5, 2); } else if (body.renderData && body.renderData.type === 'fuel') { ctx.fillStyle = 'red'; ctx.fillRect(-0.25, -0.25, 0.5, 0.5); } for (let fixture = body.getFixtureList(); fixture; fixture = fixture.getNext()) { const shape = fixture.getShape(), type = shape.getType(); if (type === 'circle') { ctx.beginPath(); ctx.arc(0, 0, shape.m_radius, 0, 2 * Math.PI); ctx.fillStyle = '#333'; ctx.fill(); ctx.strokeStyle = '#ccc'; ctx.lineWidth = 0.1; ctx.stroke(); ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(shape.m_radius, 0); ctx.stroke(); } else if (type === 'polygon') { const vs = shape.m_vertices; ctx.beginPath(); ctx.moveTo(vs[0].x, vs[0].y); for (let i = 1; i < vs.length; i++) ctx.lineTo(vs[i].x, vs[i].y); ctx.closePath(); ctx.fillStyle = body.getFixtureList() === fixture ? '#a00' : '#c00'; ctx.fill(); } else if (type === 'chain') { ctx.beginPath(); const vs = shape.m_vertices; ctx.moveTo(vs[0].x, vs[0].y); for (let i = 1; i < vs.length; i++) ctx.lineTo(vs[i].x, vs[i].y); ctx.strokeStyle = '#4a573e'; ctx.lineWidth = 0.2; ctx.stroke(); ctx.lineTo(vs[vs.length-1].x, -100); ctx.lineTo(vs[0].x, -100); ctx.closePath(); ctx.fillStyle = '#6b7f5b'; ctx.fill(); } } ctx.restore(); } updateAndRenderParticles(PHYSICS_STEP, ctx); if (gameState.debug) { ctx.lineWidth = 0.05; for (let j = world.getJointList(); j; j = j.getNext()) { const a1 = j.getAnchorA(), a2 = j.getAnchorB(); ctx.beginPath(); ctx.moveTo(a1.x, a1.y); ctx.lineTo(a2.x, a2.y); ctx.strokeStyle = 'rgba(0,255,255,0.5)'; ctx.stroke(); } } ctx.restore(); }

    // K. MAIN GAME LOOP
    let lastTime = 0, accumulator = 0;
    function gameLoop(currentTime) { requestAnimationFrame(gameLoop); const dt = (currentTime - lastTime) / 1000; lastTime = currentTime; if (gameState.paused || !world) return; input.update(); if (!gameState.gameOver) { gameState.fuel -= (GAME_PARAMS.FUEL_DRAIN_RATE + input.throttle * GAME_PARAMS.FUEL_DRAIN_THROTTLE_MULTIPLIER) * dt; if (gameState.fuel <= 0) { gameState.fuel = 0; if (vehicle.chassis.getLinearVelocity().length() < 0.1) gameState.gameOver = true; } } accumulator += dt; let steps = 0; while (accumulator >= PHYSICS_STEP && steps < MAX_ACCUMULATOR_STEPS) { vehicle.update(PHYSICS_STEP, input); world.step(PHYSICS_STEP); world.clearForces(); accumulator -= PHYSICS_STEP; steps++; } camera.update(dt, vehicle.chassis); terrainManager.update(camera.x); if (vehicle.chassis.getPosition().y < -50) input.handleReset(); render(); hud.update(); }

    // L. INITIALIZATION
    function init() {
        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);
        initWorld();
        input.init();
        const startPosition = Vec2(4, 5);
        vehicle = createVehicle(world, startPosition);
        camera = createCamera();
        terrainManager = createTerrainManager();
        terrainManager.init();
        gameState.lastCheckpoint = { pos: startPosition, angle: 0, linearVel: Vec2.zero(), angularVel: 0 };
        lastTime = performance.now();
        requestAnimationFrame(gameLoop);
    }
    init();
});
