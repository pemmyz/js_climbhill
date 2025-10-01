'use strict';

window.addEventListener('load', () => {

    // A. CONSTANTS & TUNING
    // =========================================================================
    const PPM = 60; // Pixels Per Meter
    const PHYSICS_STEP = 1 / 120; // 120 Hz physics simulation
    const MAX_ACCUMULATOR_STEPS = 5;

    const VEHICLE_PARAMS = {
        CHASSIS_MASS: 120, // kg
        REAR_BAR_DIM: { w: 1.2, h: 0.25 }, // m
        FRONT_BAR_DIM: { w: 0.8, h: 0.25 },
        FRONT_BAR_OFFSET: { x: 1.0, y: 0.05 },
        WHEEL_MASS: 12, // kg
        WHEEL_RADIUS: 0.35, // m
        WHEEL_FRICTION: 1.0,
        WHEEL_RESTITUTION: 0.1,
        TRACK_WIDTH: 1.25, // m (distance between wheel centers)
        SUSPENSION_FREQ: 6.0, // Hz
        SUSPENSION_DAMPING_RATIO: 0.8,
        SUSPENSION_TRAVEL: 0.20, // m
        MOTOR_TORQUE: 550, // N*m
        MOTOR_MAX_SPEED: 55, // rad/s (~525 RPM)
        BRAKE_TORQUE: 1200, // N*m
        ENGINE_BRAKE_TORQUE: 50,
        AIR_CONTROL_TORQUE: 120, // N*m
        MAX_ANGULAR_VELOCITY: 10, // rad/s
    };

    const TERRAIN_PARAMS = {
        SEGMENT_LENGTH: 100, // m
        SAMPLE_DISTANCE: 0.8, // m
        MAX_SLOPE: 0.8,
        GENERATION_THRESHOLD: 200, // m
        CULLING_THRESHOLD: 150, // m
        FRICTION: 0.9,
        RESTITUTION: 0.0,
        // Sum of sines parameters for height function
        A1: 0.8, F1: 0.4, P1: 0,
        A2: 0.3, F2: 1.2, P2: 0,
    };

    const GAME_PARAMS = {
        FUEL_START: 100,
        FUEL_DRAIN_RATE: 0.5, // units per second
        FUEL_DRAIN_THROTTLE_MULTIPLIER: 4.0,
        CHECKPOINT_DISTANCE: 150, // m
        FUEL_CAN_DISTANCE: 200, // m
    };

    // B. MATH & UTILITY HELPERS
    // =========================================================================
    const clamp = (val, min, max) => Math.max(min, Math.min(val, max));
    const lerp = (a, b, t) => a * (1 - t) + b * t;
    const smoothFollow = (current, target, k, dt) => lerp(current, target, 1 - Math.exp(-k * dt));

    // C. GAME STATE & WORLD SETUP
    // =========================================================================
    const canvas = document.getElementById('game-canvas');
    const ctx = canvas.getContext('2d');
    
    let world;
    let vehicle;
    let terrainManager;
    let camera;
    let particles = [];
    
    let gameState = {
        paused: false,
        debug: false,
        gameOver: false,
        distance: 0,
        fuel: GAME_PARAMS.FUEL_START,
        lastCheckpoint: null,
    };

    const pl = planck, Vec2 = pl.Vec2;

    function initWorld() {
        world = pl.World({ gravity: Vec2(0, -10) });

        world.on('begin-contact', (contact) => {
            handleContact(contact, true);
        });
        world.on('end-contact', (contact) => {
            handleContact(contact, false);
        });
    }

    function handleContact(contact, isBeginning) {
        const fixtureA = contact.getFixtureA();
        const fixtureB = contact.getFixtureB();
        const dataA = fixtureA.getUserData() || {};
        const dataB = fixtureB.getUserData() || {};

        const processContact = (objData, otherData, otherFix) => {
            if (!objData.type) return;
            switch (objData.type) {
                case 'wheel':
                    if (otherData.type === 'ground') {
                        objData.owner.setGrounded(objData.wheelId, isBeginning);
                    }
                    break;
                case 'chassis':
                     if (otherData.type === 'checkpoint') {
                        if (isBeginning) {
                            gameState.lastCheckpoint = {
                                pos: vehicle.chassis.getPosition(),
                                angle: vehicle.chassis.getAngle(),
                                linearVel: vehicle.chassis.getLinearVelocity(),
                                angularVel: vehicle.chassis.getAngularVelocity()
                            };
                            world.destroyBody(otherFix.getBody());
                        }
                    } else if (otherData.type === 'fuel') {
                        if (isBeginning) {
                            gameState.fuel = Math.min(GAME_PARAMS.FUEL_START, gameState.fuel + 50);
                            world.destroyBody(otherFix.getBody());
                        }
                    }
                    break;
            }
        };

        processContact(dataA, dataB, fixtureB);
        processContact(dataB, dataA, fixtureA);
    }

    function resizeCanvas() {
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        ctx.scale(dpr, dpr);
    }
    
    // D. INPUT MANAGER
    // =========================================================================
    const input = {
        throttle: 0, brake: 0, pitch: 0,
        fwd: false,
        keys: new Set(),
        
        init() {
            window.addEventListener('keydown', e => this.keys.add(e.code));
            window.addEventListener('keyup', e => {
                this.keys.delete(e.code);
                if (e.code === 'KeyR') this.handleReset();
                if (e.code === 'Space') gameState.paused = !gameState.paused;
                if (e.code === 'KeyH') document.getElementById('help-panel').classList.toggle('hidden');
                if (e.code === 'KeyD') gameState.debug = !gameState.debug;
                if (e.code === 'KeyG') {
                    this.fwd = !this.fwd;
                    vehicle.setFwd(this.fwd);
                }
            });

            // Mobile controls
            const setupMobileBtn = (id, action) => {
                const btn = document.getElementById(id);
                btn.addEventListener('touchstart', (e) => { e.preventDefault(); action(1); }, { passive: false });
                btn.addEventListener('touchend', (e) => { e.preventDefault(); action(0); }, { passive: false });
            };
            setupMobileBtn('throttle-btn', v => this.throttle = v);
            setupMobileBtn('brake-btn', v => this.brake = v);
            setupMobileBtn('tilt-forward-btn', v => this.pitch = v);
            setupMobileBtn('tilt-backward-btn', v => this.pitch = -v);
        },
        
        update() {
            // Keyboard
            this.throttle = this.keys.has('ArrowUp') ? 1 : 0;
            this.brake = this.keys.has('ArrowDown') ? 1 : 0;
            this.pitch = (this.keys.has('ArrowRight') ? 1 : 0) - (this.keys.has('ArrowLeft') ? 1 : 0);

            // Gamepad
            const gp = navigator.getGamepads ? navigator.getGamepads()[0] : null;
            if (gp) {
                const throttleAxis = gp.buttons[7].value; // RT
                const brakeAxis = gp.buttons[6].value;   // LT
                const pitchAxis = gp.axes[0];

                this.throttle = Math.max(this.throttle, throttleAxis);
                this.brake = Math.max(this.brake, brakeAxis);
                if (Math.abs(pitchAxis) > 0.15) {
                    this.pitch = pitchAxis;
                }
                if (gp.buttons[9].pressed) gameState.paused = !gameState.paused;
            }
        },

        handleReset() {
            if (gameState.lastCheckpoint) {
                vehicle.reset(gameState.lastCheckpoint.pos, gameState.lastCheckpoint.angle, gameState.lastCheckpoint.linearVel, gameState.lastCheckpoint.angularVel);
                gameState.fuel = Math.max(25, gameState.fuel); // Partial refill
            } else {
                vehicle.reset(Vec2(0, 5), 0, Vec2.zero(), 0);
                gameState.fuel = GAME_PARAMS.FUEL_START;
            }
            gameState.gameOver = false;
            document.getElementById('game-over-panel').classList.add('hidden');
        }
    };

    // E. TERRAIN MANAGER
    // =========================================================================
    function createTerrainManager() {
        let bodies = [];
        let lastGeneratedX = 0;
        const seed = Math.random() * 1000;
        TERRAIN_PARAMS.P1 = seed;
        TERRAIN_PARAMS.P2 = seed + 100;

        const getHeight = x => {
            const { A1, F1, P1, A2, F2, P2 } = TERRAIN_PARAMS;
            return A1 * Math.sin(F1 * x + P1) + A2 * Math.sin(F2 * x + P2);
        };

        const generateSegment = (startX) => {
            const points = [];
            let lastY = getHeight(startX);
            points.push(Vec2(startX, lastY));

            for (let x = startX + TERRAIN_PARAMS.SAMPLE_DISTANCE; x <= startX + TERRAIN_PARAMS.SEGMENT_LENGTH; x += TERRAIN_PARAMS.SAMPLE_DISTANCE) {
                let y = getHeight(x);
                // Clamp slope
                const slope = (y - lastY) / TERRAIN_PARAMS.SAMPLE_DISTANCE;
                if (Math.abs(slope) > TERRAIN_PARAMS.MAX_SLOPE) {
                    y = lastY + Math.sign(slope) * TERRAIN_PARAMS.MAX_SLOPE * TERRAIN_PARAMS.SAMPLE_DISTANCE;
                }
                points.push(Vec2(x, y));
                lastY = y;
            }

            const body = world.createBody(Vec2.zero());
            const shape = pl.Chain(points, false);
            body.createFixture(shape, {
                friction: TERRAIN_PARAMS.FRICTION,
                restitution: TERRAIN_PARAMS.RESTITUTION,
                userData: { type: 'ground' },
            });
            bodies.push({body: body, startX: startX, endX: startX + TERRAIN_PARAMS.SEGMENT_LENGTH});
            lastGeneratedX = startX + TERRAIN_PARAMS.SEGMENT_LENGTH;

            // Add collectibles
            for(let i = 1; i < points.length - 1; i++) {
                // Local maxima for checkpoints/fuel
                if (points[i].y > points[i-1].y && points[i].y > points[i+1].y) {
                    const x = points[i].x;
                    if (x > (terrainManager.lastCheckpointX + GAME_PARAMS.CHECKPOINT_DISTANCE)) {
                        createCollectible(Vec2(x, points[i].y + 1.5), 'checkpoint');
                        terrainManager.lastCheckpointX = x;
                    }
                     if (x > (terrainManager.lastFuelX + GAME_PARAMS.FUEL_CAN_DISTANCE)) {
                        createCollectible(Vec2(x, points[i].y + 1.5), 'fuel');
                        terrainManager.lastFuelX = x;
                    }
                }
            }
        };

        return {
            init() {
                this.lastCheckpointX = 0;
                this.lastFuelX = 0;
                generateSegment(0);
                generateSegment(TERRAIN_PARAMS.SEGMENT_LENGTH);
            },
            update(cameraX) {
                if (cameraX > lastGeneratedX - TERRAIN_PARAMS.GENERATION_THRESHOLD) {
                    generateSegment(lastGeneratedX);
                }
                if (bodies.length > 0 && cameraX > bodies[0].endX + TERRAIN_PARAMS.CULLING_THRESHOLD) {
                    world.destroyBody(bodies[0].body);
                    bodies.shift();
                }
            },
            getSlope(x) {
                let normal = Vec2(0, 1);
                world.rayCast(Vec2(x, 50), Vec2(x, -50), (fixture, point, n) => {
                    if (fixture.getUserData().type === 'ground') {
                        normal = n;
                        return 0; // stop raycast
                    }
                    return -1; // continue
                });
                return -normal.x / normal.y; // tan(theta)
            }
        };
    }
    
    function createCollectible(pos, type) {
        const body = world.createBody({ type: 'static', position: pos });
        const shape = pl.Box(0.5, 0.5);
        body.createFixture(shape, {
            isSensor: true,
            userData: { type: type }
        });
        body.renderData = { type };
    }


    // F. VEHICLE FACTORY
    // =========================================================================
    function createVehicle(world, pos) {
        const { CHASSIS_MASS, REAR_BAR_DIM, FRONT_BAR_DIM, FRONT_BAR_OFFSET, WHEEL_MASS, WHEEL_RADIUS, TRACK_WIDTH } = VEHICLE_PARAMS;

        const chassis = world.createDynamicBody({ position: pos });
        const totalArea = (REAR_BAR_DIM.w * REAR_BAR_DIM.h) + (FRONT_BAR_DIM.w * FRONT_BAR_DIM.h);
        const density = CHASSIS_MASS / totalArea;
        
        const commonFixtureDef = {
            density: density,
            filterGroupIndex: -1 // Prevent self-collision
        };
        chassis.createFixture(pl.Box(REAR_BAR_DIM.w / 2, REAR_BAR_DIM.h / 2), commonFixtureDef);
        chassis.createFixture(pl.Box(FRONT_BAR_DIM.w / 2, FRONT_BAR_DIM.h / 2, Vec2(FRONT_BAR_OFFSET.x, FRONT_BAR_OFFSET.y)), commonFixtureDef);
        chassis.setUserData({ type: 'chassis' });

        const wheelFixtureDef = {
            density: WHEEL_MASS / (Math.PI * WHEEL_RADIUS * WHEEL_RADIUS),
            friction: VEHICLE_PARAMS.WHEEL_FRICTION,
            restitution: VEHICLE_PARAMS.WHEEL_RESTITUTION,
            filterGroupIndex: -1,
        };

        const rearWheel = world.createDynamicBody({
            position: pos.clone().add(Vec2(-TRACK_WIDTH / 2, -0.4)),
            bullet: true,
        });
        rearWheel.createFixture(pl.Circle(WHEEL_RADIUS), { ...wheelFixtureDef, userData: { type: 'wheel', wheelId: 'rear', owner: null } });

        const frontWheel = world.createDynamicBody({
            position: pos.clone().add(Vec2(TRACK_WIDTH / 2, -0.4)),
            bullet: true,
        });
        frontWheel.createFixture(pl.Circle(WHEEL_RADIUS), { ...wheelFixtureDef, userData: { type: 'wheel', wheelId: 'front', owner: null } });

        // Suspension - using Prismatic Joints and manual spring forces
        const createSuspension = (wheel, anchor) => {
            const joint = world.createJoint(pl.PrismaticJoint({
                lowerTranslation: -VEHICLE_PARAMS.SUSPENSION_TRAVEL,
                upperTranslation: VEHICLE_PARAMS.SUSPENSION_TRAVEL,
                enableLimit: true,
            }, chassis, wheel, wheel.getPosition(), Vec2(0, 1)));
            return joint;
        };
        const rearSuspension = createSuspension(rearWheel, Vec2(-TRACK_WIDTH / 2, 0));
        const frontSuspension = createSuspension(frontWheel, Vec2(TRACK_WIDTH / 2, 0));

        const vehicleObj = {
            chassis, rearWheel, frontWheel,
            isFwd: false,
            rearGrounded: false, frontGrounded: false,
            groundContactCount: { rear: 0, front: 0 },

            setFwd(isOn) { this.isFwd = isOn; },

            setGrounded(wheelId, isGrounded) {
                this.groundContactCount[wheelId] += isGrounded ? 1 : -1;
                this[wheelId + 'Grounded'] = this.groundContactCount[wheelId] > 0;
            },

            reset(pos, angle, linearVel, angularVel) {
                this.chassis.setPosition(pos);
                this.chassis.setAngle(angle);
                this.chassis.setLinearVelocity(linearVel || Vec2.zero());
                this.chassis.setAngularVelocity(angularVel || 0);
                
                // Reposition wheels relative to the reset chassis
                const rearAnchor = chassis.getWorldPoint(Vec2(-TRACK_WIDTH / 2, -0.4));
                const frontAnchor = chassis.getWorldPoint(Vec2(TRACK_WIDTH / 2, -0.4));
                this.rearWheel.setPosition(rearAnchor);
                this.frontWheel.setPosition(frontAnchor);
                this.rearWheel.setLinearVelocity(linearVel || Vec2.zero());
                this.frontWheel.setLinearVelocity(linearVel || Vec2.zero());
            },

            // This is the core physics update for the vehicle.
            update(dt, input) {
                // 1. Apply suspension forces manually
                const applySpringForce = (joint, wheel) => {
                    const { SUSPENSION_FREQ, SUSPENSION_DAMPING_RATIO } = VEHICLE_PARAMS;
                    const m_eff = (CHASSIS_MASS / 2) + WHEEL_MASS; // Effective mass per wheel
                    const omega = 2 * Math.PI * SUSPENSION_FREQ;
                    const k = omega * omega * m_eff; // Stiffness
                    const c = 2 * SUSPENSION_DAMPING_RATIO * omega * m_eff; // Damping
                    
                    const x = joint.getJointTranslation();
                    const v = joint.getJointSpeed();
                    const forceMag = -k * x - c * v;

                    const axis = chassis.getWorldVector(Vec2(0, 1));
                    const force = axis.mul(forceMag);
                    const wheelPos = wheel.getPosition();
                    const chassisAnchor = joint.getAnchorA();

                    wheel.applyForce(force, wheelPos);
                    chassis.applyForce(force.mul(-1), chassisAnchor);
                };
                applySpringForce(rearSuspension, rearWheel);
                applySpringForce(frontSuspension, frontWheel);

                // 2. Air control
                if (!this.rearGrounded && !this.frontGrounded) {
                    const currentOmega = this.chassis.getAngularVelocity();
                    // Applying torque to counteract current spin and move towards target
                    const targetOmega = 0; // Default to stabilizing
                    let torque = -input.pitch * VEHICLE_PARAMS.AIR_CONTROL_TORQUE;
                    torque -= currentOmega * 200; // Damping to prevent wild spinning
                    this.chassis.applyTorque(clamp(torque, -VEHICLE_PARAMS.AIR_CONTROL_TORQUE, VEHICLE_PARAMS.AIR_CONTROL_TORQUE));
                }

                // Cap angular velocity to prevent physics explosions
                const currentAngVel = this.chassis.getAngularVelocity();
                if(Math.abs(currentAngVel) > VEHICLE_PARAMS.MAX_ANGULAR_VELOCITY) {
                    this.chassis.setAngularVelocity(Math.sign(currentAngVel) * VEHICLE_PARAMS.MAX_ANGULAR_VELOCITY);
                }

                // 3. Motor and Brakes
                const applyDriveTorque = (wheel, isGrounded) => {
                    if (!isGrounded) return 0;
                    const { MOTOR_TORQUE, MOTOR_MAX_SPEED, BRAKE_TORQUE, ENGINE_BRAKE_TORQUE } = VEHICLE_PARAMS;
                    const wheelSpeed = wheel.getAngularVelocity();
                    let torque = 0;

                    if (input.brake > 0) {
                        torque = BRAKE_TORQUE * Math.sign(wheelSpeed) * -1;
                    } else if (input.throttle > 0) {
                        if (wheelSpeed > -MOTOR_MAX_SPEED) {
                            torque = -MOTOR_TORQUE * input.throttle;
                        }
                    } else { // Engine braking
                        torque = ENGINE_BRAKE_TORQUE * Math.sign(wheelSpeed) * -1;
                    }
                    wheel.applyTorque(torque);
                };
                
                applyDriveTorque(rearWheel, this.rearGrounded);
                if (this.isFwd) {
                    applyDriveTorque(frontWheel, this.frontGrounded);
                } else if (input.brake > 0) { // Brakes always apply to front too
                    const wheelSpeed = frontWheel.getAngularVelocity();
                    frontWheel.applyTorque(VEHICLE_PARAMS.BRAKE_TORQUE * Math.sign(wheelSpeed) * -1);
                }
            }
        };

        // Set owner on user data for contact listener
        rearWheel.getFixtureList().getUserData().owner = vehicleObj;
        frontWheel.getFixtureList().getUserData().owner = vehicleObj;

        return vehicleObj;
    }

    // G. CAMERA
    // =========================================================================
    function createCamera() {
        return {
            x: 0, y: 0, zoom: 1.0,
            update(dt, targetBody) {
                const targetPos = targetBody.getPosition();
                const targetVel = targetBody.getLinearVelocity();

                // Look slightly ahead of the car
                const lookahead = Vec2(targetVel.x * 0.4, targetVel.y * 0.2);
                const finalTarget = targetPos.clone().add(lookahead).add(Vec2(2, 1));
                
                this.x = smoothFollow(this.x, finalTarget.x, 5, dt);
                this.y = smoothFollow(this.y, finalTarget.y, 5, dt);
            }
        };
    }
    
    // H. PARTICLE SYSTEM (simple)
    // =========================================================================
    function spawnParticle(pos, vel, lifetime, color) {
        particles.push({ pos, vel, lifetime, maxLifetime: lifetime, color });
    }

    function updateAndRenderParticles(dt, ctx) {
        for (let i = particles.length - 1; i >= 0; i--) {
            const p = particles[i];
            p.pos.add(p.vel.mul(dt));
            p.vel.y -= 20 * dt; // Gravity on particles
            p.lifetime -= dt;
            if (p.lifetime <= 0) {
                particles.splice(i, 1);
            } else {
                const alpha = p.lifetime / p.maxLifetime;
                ctx.fillStyle = `rgba(${p.color}, ${alpha})`;
                ctx.fillRect(p.pos.x, p.pos.y, 0.1, 0.1);
            }
        }
    }

    // I. UI / HUD
    // =========================================================================
    const hud = {
        speed: document.getElementById('speed-value'),
        rpm: document.getElementById('rpm-value'),
        fuel: document.getElementById('fuel-value'),
        distance: document.getElementById('distance-value'),
        slope: document.getElementById('slope-value'),
        gameOverPanel: document.getElementById('game-over-panel'),
        
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

            if(gameState.gameOver) {
                this.gameOverPanel.classList.remove('hidden');
            }
        }
    };
    
    // J. RENDERING
    // =========================================================================
    function render() {
        const { width, height } = canvas;
        const dpr = window.devicePixelRatio || 1;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        // Clear canvas
        const skyGradient = ctx.createLinearGradient(0, 0, 0, height);
        skyGradient.addColorStop(0, '#4b759e');
        skyGradient.addColorStop(1, '#9cd2f2');
        ctx.fillStyle = skyGradient;
        ctx.fillRect(0, 0, width, height);

        // Set camera transform
        ctx.save();
        ctx.translate(width / 2 / dpr, height / 2 / dpr);
        ctx.scale(PPM * camera.zoom, -PPM * camera.zoom); // Flip Y-axis
        ctx.translate(-camera.x, -camera.y);

        // Render world
        for (let body = world.getBodyList(); body; body = body.getNext()) {
            const pos = body.getPosition();
            const angle = body.getAngle();
            ctx.save();
            ctx.translate(pos.x, pos.y);
            ctx.rotate(angle);

            if (body.renderData && body.renderData.type === 'checkpoint') {
                 ctx.fillStyle = 'gold';
                 ctx.fillRect(-0.25, -1, 0.5, 2);
            } else if (body.renderData && body.renderData.type === 'fuel') {
                 ctx.fillStyle = 'red';
                 ctx.fillRect(-0.25, -0.25, 0.5, 0.5);
            }

            for (let fixture = body.getFixtureList(); fixture; fixture = fixture.getNext()) {
                const shape = fixture.getShape();
                const type = shape.getType();
                
                if (type === 'circle') {
                    ctx.beginPath();
                    ctx.arc(0, 0, shape.m_radius, 0, 2 * Math.PI);
                    ctx.fillStyle = '#333';
                    ctx.fill();
                    ctx.strokeStyle = '#ccc';
                    ctx.lineWidth = 0.1;
                    ctx.stroke();
                    // Spoke for rotation visualization
                    ctx.beginPath();
                    ctx.moveTo(0,0);
                    ctx.lineTo(shape.m_radius, 0);
                    ctx.stroke();

                } else if (type === 'polygon') {
                    const vertices = shape.m_vertices;
                    ctx.beginPath();
                    ctx.moveTo(vertices[0].x, vertices[0].y);
                    for (let i = 1; i < vertices.length; i++) {
                        ctx.lineTo(vertices[i].x, vertices[i].y);
                    }
                    ctx.closePath();
                    ctx.fillStyle = body === vehicle.chassis.getFixtureList().m_body ? '#a00' : '#c00';
                    ctx.fill();
                    
                } else if (type === 'chain') {
                    ctx.beginPath();
                    const vertices = shape.m_vertices;
                    ctx.moveTo(vertices[0].x, vertices[0].y);
                    for (let i = 1; i < vertices.length; i++) {
                        ctx.lineTo(vertices[i].x, vertices[i].y);
                    }
                    ctx.strokeStyle = '#4a573e';
                    ctx.lineWidth = 0.2;
                    ctx.stroke();
                    
                    // Fill under terrain
                    ctx.lineTo(vertices[vertices.length-1].x, -100);
                    ctx.lineTo(vertices[0].x, -100);
                    ctx.closePath();
                    ctx.fillStyle = '#6b7f5b';
                    ctx.fill();
                }
            }
            ctx.restore();
        }

        updateAndRenderParticles(PHYSICS_STEP, ctx);

        // Debug drawing
        if (gameState.debug) {
            ctx.lineWidth = 0.05;
            for (let j = world.getJointList(); j; j = j.getNext()) {
                const a1 = j.getAnchorA();
                const a2 = j.getAnchorB();
                ctx.beginPath();
                ctx.moveTo(a1.x, a1.y);
                ctx.lineTo(a2.x, a2.y);
                ctx.strokeStyle = 'rgba(0,255,255,0.5)';
                ctx.stroke();
            }
        }

        ctx.restore();
    }


    // K. MAIN GAME LOOP
    // =========================================================================
    let lastTime = 0;
    let accumulator = 0;

    function gameLoop(currentTime) {
        requestAnimationFrame(gameLoop);
        
        const dt = (currentTime - lastTime) / 1000;
        lastTime = currentTime;

        if (gameState.paused || !world) return;

        input.update();

        // Update fuel and check for game over
        if (!gameState.gameOver) {
            gameState.fuel -= (GAME_PARAMS.FUEL_DRAIN_RATE + input.throttle * GAME_PARAMS.FUEL_DRAIN_THROTTLE_MULTIPLIER) * dt;
            if (gameState.fuel <= 0) {
                gameState.fuel = 0;
                if (vehicle.chassis.getLinearVelocity().length() < 0.1) {
                    gameState.gameOver = true;
                }
            }
        }
        
        vehicle.setFwd(input.fwd);

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

        if (vehicle.chassis.getPosition().y < -50) {
            input.handleReset();
        }

        render();
        hud.update();
    }

    // L. INITIALIZATION
    // =========================================================================
    function init() {
        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);
        
        initWorld();
        input.init();
        
        vehicle = createVehicle(world, Vec2(0, 5));
        camera = createCamera();
        terrainManager = createTerrainManager();
        terrainManager.init();
        
        gameState.lastCheckpoint = { pos: Vec2(0, 5), angle: 0, linearVel: Vec2.zero(), angularVel: 0 };
        
        lastTime = performance.now();
        requestAnimationFrame(gameLoop);
    }

    init();
});
