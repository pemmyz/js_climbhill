'use strict';

window.addEventListener('load', () => {

    // A. CONSTANTS & TUNING
    // =========================================================================
    const PPM = 60; // Pixels Per Meter
    const PHYSICS_STEP = 1 / 120; // 120 Hz physics simulation
    const MAX_ACCUMULATOR_STEPS = 5;

    // == VEHICLE PARAMETERS ==
    const VEHICLE_PARAMS = {
        CHASSIS_MASS: 180,

        REAR_BAR_DIM: { w: 1.2, h: 0.25 },
        FRONT_BAR_DIM: { w: 0.8, h: 0.25 },
        FRONT_BAR_OFFSET: { x: 0.8, y: -0.05 },

        WHEEL_MASS: 12,
        WHEEL_RADIUS: 0.35,
        WHEEL_FRICTION: 1.6,
        WHEEL_RESTITUTION: 0.05,
        TRACK_WIDTH: 1.5,

        // Softer, slightly bouncy suspension
        SUSPENSION_FREQ_HZ: 2.0,          // lower = softer
        SUSPENSION_DAMPING_RATIO: 0.45,   // < 0.5 = a bit of bounce
        SUSPENSION_TRAVEL: 0.35,
        MAX_SPRING_FORCE: 80000,

        // Wheel motor & brakes
        MOTOR_TORQUE: 900,            // Nm (how hard the motor can push)
        MOTOR_MAX_SPEED: 70,          // rad/s (cap for wheel motor speed)
        BRAKE_TORQUE: 1800,           // Nm (hard brakes)
        ENGINE_BRAKE_TORQUE: 70,      // Nm (drag when coasting)

        // Spin the whole car on its axis (Left/Right)
        AIR_CONTROL_TORQUE: 1800,     // stronger spin
        AIR_CONTROL_DAMPING: 30
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
        checkPair(dataA, dataB, contact.getFixtureB()); 
        checkPair(dataB, dataA, contact.getFixtureA());
    }

    function resizeCanvas() { 
        const dpr = window.devicePixelRatio || 1; 
        const rect = canvas.getBoundingClientRect(); 
        canvas.width = rect.width * dpr; 
        canvas.height = rect.height * dpr; 
        ctx.scale(dpr, dpr); 
    }
    
    // D. INPUT MANAGER
    const input = {
        throttle: 0, brake: 0, pitch: 0, keys: new Set(),
        init() {
            const helpPanel = document.getElementById('help-panel');
            const helpToggleButton = document.getElementById('help-toggle-button');
            const closeHelpBtn = document.getElementById('close-help-btn');
            
            const toggleHelp = () => helpPanel.classList.toggle('hidden');

            // Keyboard Listeners
            window.addEventListener('keydown', e => this.keys.add(e.code));
            window.addEventListener('keyup', e => {
                this.keys.delete(e.code);
                if (e.code === 'KeyR') this.handleReset();
                if (e.code === 'Space') gameState.paused = !gameState.paused;
                if (e.code === 'KeyH') toggleHelp();
                if (e.code === 'KeyD') gameState.debug = !gameState.debug;
            });

            if (helpToggleButton) helpToggleButton.addEventListener('click', toggleHelp);
            if (closeHelpBtn) closeHelpBtn.addEventListener('click', toggleHelp);
            
            // Pointer Event Setup (Handles Touch & Mouse smoothly)
            const setupMobileBtn = (id, action) => { 
                const btn = document.getElementById(id); 
                if (!btn) return;
                
                const press = (e) => { 
                    e.preventDefault(); 
                    btn.classList.add('active'); // Visual feedback
                    action(1); 
                };
                const release = (e) => { 
                    e.preventDefault(); 
                    btn.classList.remove('active'); 
                    action(0); 
                };

                // Use pointer events for cross-platform (desktop + mobile) robustness
                btn.addEventListener('pointerdown', press); 
                btn.addEventListener('pointerup', release); 
                btn.addEventListener('pointercancel', release); 
                btn.addEventListener('pointerleave', release); 

                // Prevent right-click/long-press menus on these buttons
                btn.addEventListener('contextmenu', e => e.preventDefault());
            };

            setupMobileBtn('throttle-btn', v => this.throttle = v); 
            setupMobileBtn('brake-btn', v => this.brake = v); 
            setupMobileBtn('tilt-forward-btn', v => this.pitch = v); 
            setupMobileBtn('tilt-backward-btn', v => this.pitch = -v);
        },
        update() { 
            // Prefer Keyboard if pressed, fallback to visual touch values
            if (this.keys.has('ArrowUp')) this.throttle = 1;
            if (this.keys.has('ArrowDown')) this.brake = 1;
            
            let keyPitch = (this.keys.has('ArrowRight') ? 1 : 0) - (this.keys.has('ArrowLeft') ? 1 : 0);
            if (keyPitch !== 0) this.pitch = keyPitch;

            const gp = navigator.getGamepads ? navigator.getGamepads()[0] : null; 
            if (gp) { 
                this.throttle = Math.max(this.throttle, gp.buttons[7].value); 
                this.brake = Math.max(this.brake, gp.buttons[6].value); 
                if (Math.abs(gp.axes[0]) > 0.15) this.pitch = gp.axes[0]; 
                if (gp.buttons[9].pressed) gameState.paused = !gameState.paused; 
            } 
        },
        
        handleReset() {
            if (gameState.lastCheckpoint) {
                const checkpointPos = gameState.lastCheckpoint.pos;
                const yOffset = 5 * VEHICLE_PARAMS.WHEEL_RADIUS; // 5 wheel heights
                const spawnPos = Vec2(checkpointPos.x, checkpointPos.y + yOffset);
                vehicle.reset(spawnPos, 0, Vec2.zero(), 0);
                gameState.fuel = Math.max(25, gameState.fuel);
            } else {
                vehicle.reset(Vec2(4, 5), 0, Vec2.zero(), 0);
                gameState.fuel = GAME_PARAMS.FUEL_START;
            }
            gameState.gameOver = false;
            document.getElementById('game-over-panel').classList.add('hidden');
        }
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
        const {
            CHASSIS_MASS, REAR_BAR_DIM, FRONT_BAR_DIM, FRONT_BAR_OFFSET,
            WHEEL_MASS, WHEEL_RADIUS, TRACK_WIDTH,
            WHEEL_FRICTION, WHEEL_RESTITUTION,
            SUSPENSION_FREQ_HZ, SUSPENSION_DAMPING_RATIO, SUSPENSION_TRAVEL,
            MOTOR_TORQUE, MOTOR_MAX_SPEED, BRAKE_TORQUE, ENGINE_BRAKE_TORQUE
        } = VEHICLE_PARAMS;

        const pl = planck, Vec2 = pl.Vec2;

        const chassis = world.createDynamicBody({ position: pos, angularDamping: 0.1 });
        const density = CHASSIS_MASS / ((REAR_BAR_DIM.w * REAR_BAR_DIM.h) + (FRONT_BAR_DIM.w * FRONT_BAR_DIM.h));
        const chassisFixtureDef = { density, filterGroupIndex: -1 };
        chassis.createFixture(pl.Box(REAR_BAR_DIM.w / 2, REAR_BAR_DIM.h / 2, Vec2(-0.2, 0)), chassisFixtureDef);
        chassis.createFixture(pl.Box(FRONT_BAR_DIM.w / 2, FRONT_BAR_DIM.h / 2, Vec2(FRONT_BAR_OFFSET.x, FRONT_BAR_OFFSET.y)), chassisFixtureDef);
        chassis.setUserData({ type: 'chassis' });

        const wheelFixtureDef = {
            density: WHEEL_MASS / (Math.PI * WHEEL_RADIUS * WHEEL_RADIUS),
            friction: WHEEL_FRICTION,
            restitution: WHEEL_RESTITUTION,
            filterGroupIndex: -1
        };

        const rearWheelAnchorLocal  = Vec2(-TRACK_WIDTH / 2, -1.0);
        const frontWheelAnchorLocal = Vec2( TRACK_WIDTH / 2, -1.0);

        function makeWheel(wheelId, anchorLocal) {
            const wheel = world.createDynamicBody({
            position: chassis.getWorldPoint(anchorLocal),
            bullet: true,
            angularDamping: 0.05
            });
            const fix = wheel.createFixture(pl.Circle(WHEEL_RADIUS), {
            ...wheelFixtureDef,
            userData: { type: 'wheel', wheelId, owner: null }
            });

            const axis = chassis.getWorldVector(Vec2(0, 1));
            const j = world.createJoint(pl.WheelJoint({
            motorSpeed: 0,
            maxMotorTorque: 0,
            enableMotor: false,
            frequencyHz: SUSPENSION_FREQ_HZ,
            dampingRatio: SUSPENSION_DAMPING_RATIO,
            enableLimit: true,
            lowerTranslation: -SUSPENSION_TRAVEL,
            upperTranslation:  SUSPENSION_TRAVEL,
            }, chassis, wheel, chassis.getWorldPoint(anchorLocal), axis));

            return { wheel, joint: j };
        }

        const rear  = makeWheel('rear',  rearWheelAnchorLocal);
        const front = makeWheel('front', frontWheelAnchorLocal);

        const vehicleObj = {
            chassis,
            rearWheel: rear.wheel,
            frontWheel: front.wheel,
            rearJoint: rear.joint,
            frontJoint: front.joint,
            groundContactCount: { rear: 0, front: 0 },
            totalAppliedTorque: 0,

            get isRearGrounded()  { return this.groundContactCount.rear  > 0; },
            get isFrontGrounded() { return this.groundContactCount.front > 0; },

            setGrounded(wheelId, isGrounded) {
            this.groundContactCount[wheelId] += isGrounded ? 1 : -1;
            },

            reset(pos, angle, linearVel, angularVel) {
            this.chassis.setPosition(pos);
            this.chassis.setAngle(angle);
            this.chassis.setLinearVelocity(linearVel || Vec2.zero());
            this.chassis.setAngularVelocity(angularVel || 0);
            this.rearWheel.setPosition(chassis.getWorldPoint(rearWheelAnchorLocal));
            this.frontWheel.setPosition(chassis.getWorldPoint(frontWheelAnchorLocal));
            this.rearWheel.setLinearVelocity(linearVel || Vec2.zero());
            this.frontWheel.setLinearVelocity(linearVel || Vec2.zero());
            this.rearWheel.setAngularVelocity(0);
            this.frontWheel.setAngularVelocity(0);
            },

            update(dt, input) {
            if (input.throttle > 0) {
                this.rearJoint.enableMotor(true);
                this.rearJoint.setMotorSpeed(-input.throttle * VEHICLE_PARAMS.MOTOR_MAX_SPEED);
                this.rearJoint.setMaxMotorTorque(VEHICLE_PARAMS.MOTOR_TORQUE);
            } else {
                this.rearJoint.enableMotor(false);
                const rearOmega = this.rearWheel.getAngularVelocity();
                if (this.isRearGrounded) {
                const engineDrag = clamp(-rearOmega * 10, -ENGINE_BRAKE_TORQUE, ENGINE_BRAKE_TORQUE);
                this.rearWheel.applyTorque(engineDrag, true);
                }
            }

            if (input.brake > 0) {
                const rearOmega  = this.rearWheel.getAngularVelocity();
                const frontOmega = this.frontWheel.getAngularVelocity();
                const rearOppose  = clamp(-rearOmega  * 120, -BRAKE_TORQUE, BRAKE_TORQUE);
                const frontOppose = clamp(-frontOmega * 120, -BRAKE_TORQUE, BRAKE_TORQUE);
                this.rearWheel.applyTorque(rearOppose, true);
                this.frontWheel.applyTorque(frontOppose, true);
            }

            let totalRotationalTorque = 0;
            const playerTorque = -input.pitch * VEHICLE_PARAMS.AIR_CONTROL_TORQUE;
            totalRotationalTorque += playerTorque;
            const currentOmega = this.chassis.getAngularVelocity();
            totalRotationalTorque -= currentOmega * VEHICLE_PARAMS.AIR_CONTROL_DAMPING;
            this.chassis.applyTorque(totalRotationalTorque, true);
            this.totalAppliedTorque = totalRotationalTorque;
            }
        };

        rear.wheel.getFixtureList().getUserData().owner  = vehicleObj;
        front.wheel.getFixtureList().getUserData().owner = vehicleObj;

        return vehicleObj;
    }

    // G. CAMERA
    function createCamera() { return { x: 0, y: 0, zoom: 1.0, update(dt, targetBody) { const targetPos = targetBody.getPosition(); const targetVel = targetBody.getLinearVelocity(); const lookahead = Vec2(targetVel.x * 0.4, targetVel.y * 0.2); const finalTarget = targetPos.clone().add(lookahead).add(Vec2(2, 1)); this.x = smoothFollow(this.x, finalTarget.x, 3, dt); this.y = smoothFollow(this.y, finalTarget.y, 3, dt); } }; }
    
    // H. PARTICLE SYSTEM
    function spawnParticle(pos, vel, lifetime, color) { particles.push({ pos, vel, lifetime, maxLifetime: lifetime, color }); }
    function updateAndRenderParticles(dt, ctx) { for (let i = particles.length - 1; i >= 0; i--) { const p = particles[i]; p.pos.add(p.vel.mul(dt)); p.vel.y -= 20 * dt; p.lifetime -= dt; if (p.lifetime <= 0) particles.splice(i, 1); else { const a = p.lifetime / p.maxLifetime; ctx.fillStyle = `rgba(${p.color}, ${a})`; ctx.fillRect(p.pos.x, p.pos.y, 0.1, 0.1); } } }

    // I. UI / HUD
    const hud = {
        element: document.getElementById('hud'),
        speed: document.getElementById('speed-value'),
        rpm: document.getElementById('rpm-value'),
        fuel: document.getElementById('fuel-value'),
        distance: document.getElementById('distance-value'),
        slope: document.getElementById('slope-value'),
        gameOverPanel: document.getElementById('game-over-panel'),
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
            const angleDegrees = (vehicle.chassis.getAngle() * 180 / Math.PI) % 360;
            this.angle.textContent = angleDegrees.toFixed(0);
            this.torque.textContent = vehicle.totalAppliedTorque.toFixed(0);
            
            if(gameState.gameOver) this.gameOverPanel.classList.remove('hidden');

            if (gameState.debug) {
                this.element.style.backgroundColor = 'rgba(80, 20, 20, 0.7)';
            } else {
                this.element.style.backgroundColor = '';
            }
        }
    };
    
    // J. RENDERING
    function render() { const { width, height } = canvas; const dpr = window.devicePixelRatio || 1; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); const skyGradient = ctx.createLinearGradient(0, 0, 0, height); skyGradient.addColorStop(0, '#4b759e'); skyGradient.addColorStop(1, '#9cd2f2'); ctx.fillStyle = skyGradient; ctx.fillRect(0, 0, width, height); ctx.save(); ctx.translate(width / 2 / dpr, height / 2 / dpr); ctx.scale(PPM * camera.zoom, -PPM * camera.zoom); ctx.translate(-camera.x, -camera.y); for (let body = world.getBodyList(); body; body = body.getNext()) { const pos = body.getPosition(); const angle = body.getAngle(); ctx.save(); ctx.translate(pos.x, pos.y); ctx.rotate(angle); if (body.renderData && body.renderData.type === 'checkpoint') { ctx.fillStyle = 'gold'; ctx.fillRect(-0.25, -1, 0.5, 2); } else if (body.renderData && body.renderData.type === 'fuel') { ctx.fillStyle = 'red'; ctx.fillRect(-0.25, -0.25, 0.5, 0.5); } for (let fixture = body.getFixtureList(); fixture; fixture = fixture.getNext()) { const shape = fixture.getShape(), type = shape.getType(); if (type === 'circle') { ctx.beginPath(); ctx.arc(0, 0, shape.m_radius, 0, 2 * Math.PI); ctx.fillStyle = '#333'; ctx.fill(); ctx.strokeStyle = '#ccc'; ctx.lineWidth = 0.1; ctx.stroke(); ctx.beginPath(); ctx.moveTo(0,0); ctx.lineTo(shape.m_radius, 0); ctx.stroke(); } else if (type === 'polygon') { const vs = shape.m_vertices; ctx.beginPath(); ctx.moveTo(vs[0].x, vs[0].y); for (let i = 1; i < vs.length; i++) ctx.lineTo(vs[i].x, vs[i].y); ctx.closePath(); ctx.fillStyle = body.getFixtureList() === fixture ? '#a00' : '#c00'; ctx.fill(); } else if (type === 'chain') { ctx.beginPath(); const vs = shape.m_vertices; ctx.moveTo(vs[0].x, vs[0].y); for (let i = 1; i < vs.length; i++) ctx.lineTo(vs[i].x, vs[i].y); ctx.strokeStyle = '#4a573e'; ctx.lineWidth = 0.2; ctx.stroke(); ctx.lineTo(vs[vs.length-1].x, -100); ctx.lineTo(vs[0].x, -100); ctx.closePath(); ctx.fillStyle = '#6b7f5b'; ctx.fill(); } } ctx.restore(); } updateAndRenderParticles(PHYSICS_STEP, ctx); if (gameState.debug) { ctx.lineWidth = 0.05; for (let j = world.getJointList(); j; j = j.getNext()) { const a1 = j.getAnchorA(), a2 = j.getAnchorB(); ctx.beginPath(); ctx.moveTo(a1.x, a1.y); ctx.lineTo(a2.x, a2.y); ctx.strokeStyle = 'rgba(0,255,255,0.5)'; ctx.stroke(); } } ctx.restore(); }

    // K. MAIN GAME LOOP
    let lastTime = 0, accumulator = 0;
    function gameLoop(currentTime) {
        requestAnimationFrame(gameLoop);
        const dt = (currentTime - lastTime) / 1000;
        lastTime = currentTime;
        if (gameState.paused || !world) return;
        
        input.update();

        if (!gameState.gameOver) {
            if (!gameState.debug) {
                gameState.fuel -= (GAME_PARAMS.FUEL_DRAIN_RATE + input.throttle * GAME_PARAMS.FUEL_DRAIN_THROTTLE_MULTIPLIER) * dt;
                if (gameState.fuel <= 0) {
                    gameState.fuel = 0;
                    if (vehicle.chassis.getLinearVelocity().length() < 0.1) gameState.gameOver = true;
                }
            } else {
                gameState.fuel = GAME_PARAMS.FUEL_START;
            }
        }
        
        accumulator += dt;
        let steps = 0;
        while (accumulator >= PHYSICS_STEP && steps < MAX_ACCUMULATOR_STEPS) {
            vehicle.update(PHYSICS_STEP, input);
            world.step(PHYSICS_STEP);
            world.clearForces();
            accumulator -= PHYSICS_STEP;
            steps++;
        }
        
        camera.update(dt, vehicle.chassis);
        terrainManager.update(camera.x);
        if (vehicle.chassis.getPosition().y < -50) input.handleReset();
        
        render();
        hud.update();
    }

    // --- FULLSCREEN & MOBILE SCALING LOGIC ---
    const screenElement = document.getElementById("screen");
    const fullscreenBtn = document.getElementById("fullscreen-btn");

    function scaleGame() {
        // ALWAYS apply scaling so it perfectly fits the browser window.
        const baseWidth = 960;
        const baseHeight = 540; // 16:9 ratio
        
        if (screenElement) {
            screenElement.style.width = baseWidth + 'px';
            screenElement.style.height = baseHeight + 'px';
            screenElement.style.maxWidth = 'none';
            
            const scale = Math.min(
                window.innerWidth / baseWidth,
                window.innerHeight / baseHeight
            );
            
            screenElement.style.transform = `scale(${scale})`;
        }
        
        // Detect native fullscreen state
        const isFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement);
        
        // Toggles the CSS class triggering on-screen controls explicitly
        if (isFullscreen) {
            document.body.classList.add('is-fullscreen');
        } else {
            document.body.classList.remove('is-fullscreen');
        }

        // Prevent body scrolling/bouncing natively
        document.body.style.overflow = 'hidden';
        document.body.style.touchAction = 'none';
        document.body.style.margin = '0';
        document.body.style.padding = '0';
        
        setTimeout(resizeCanvas, 50);
    }

    function goFull() {
        const el = document.documentElement;
        if (el.requestFullscreen) el.requestFullscreen();
        else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
    }

    window.addEventListener("fullscreenchange", scaleGame);
    window.addEventListener("webkitfullscreenchange", scaleGame);
    if (fullscreenBtn) fullscreenBtn.addEventListener('click', goFull);

    // L. INITIALIZATION
    function init() {
        scaleGame();
        window.addEventListener('resize', scaleGame);

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
