/*
	Copyright 2018-2021 JasX
	Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
	The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
	THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/
// This is a client script, it won't work with node

class VhSocket{


	// OVERRIDABLE EVENTS //

	// A device connected to this app has come online or been added
	onDeviceOnline( device ){

		console.log("The device", device, "has come online");

	}

	// A device connected to this app has gone offline
	onDeviceOffline( device ){

		console.log("The device ", device, "has gone offline");

	}

	onDeviceBattery( device ){

		console.log("The device", device, "reports battery mV", device.batteryMillivolts, "and low voltage: ", device.batteryLow);

	}

	// Message received from a modified VibHub device
	onCustomMessage( id, sid, data ){

		if( !Array.isArray(data) )
			return;

		let task = data.shift(),
			val = data.shift()
		;
		console.log("Message received. Id:", id, "SID:", sid, "Task", task, "Val", val);

	}

	onConnected(){
		console.log("Socket IO connected");
	}
	onDisconnected(){
		console.log("Socket IO disconnected");
	}
	
	// Raised 60 times per second
	onTick(){}




	// CODE BEGINS HERE //

	// Internal stuff here
	constructor( appName, server = "https://vibhub.io", port = 443, fps = 30, autoHighRes = false ){
		
		this.appName = appName;
		this.server = server;
		this.port = port;
		this.fps = fps;
		this.devices = [];
		this.socket = null;
		this.ticker = null;
		this.connected = false;
		this.autoHighRes = autoHighRes;

		while( this.server[this.server.length-1] === '/' )
			this.server = this.server.substring(0, this.server.length-1);

	}

	// Starts the connection and sets up name
	async begin(){

		if( this.socket )
			throw 'Only call begin once';
		
		await this._addScript();
		this.socket = io(this.server);
		this.socket.on('dev_online', data => this.handleDeviceOnline(data));
		this.socket.on('dev_offline', data => this.handleDeviceOffline(data));
		this.socket.on('aCustom', data => this.onCustomMessage.apply( this, data ));
		this.socket.on('disconnect', () => {
			this.connected = false;
			this.onDisconnected();
		});
		this.socket.on('sb', data => this.handleDeviceBattery(data));

		await new Promise(res => {
			this.socket.on('connect', res);
		});

		this.connected = true;
		this.onConnected();
		
		const success = await this.setName();
		if( !success )
			throw 'Unable to set name. Make sure the server is up to date!';
		
		this.ticker = setInterval(this.tick.bind(this), 1000.0/this.fps);

	}
	
	isConnected(){
		return this.connected;
	}

	// Sends our app name to the server
	async setName(){

		return await new Promise(res => {
			this.socket.emit('app', this.appName, success => { 
				res(success); 
			});
		});

	}

	// Handles the device array changed from the server
	async handleNewIndex( devices = [] ){

		const out = [];
		for( let i in devices ){

			const device = devices[i];
			let ex = this.getDevice(device, this);
			if( !ex ){
				ex = new VhDevice(device, this);
				if( this.autoHighRes )
					device.setHiRes(true);
				
			}
			ex.index = parseInt(i);
			out.push(ex);

		}
		this.devices = out;	// Update our array of devices.

	}

	handleDeviceOnline( data ){
		
		const id = data[0],
			socket = data[1],
			meta = data[2]
		;

		let device = this.getDevice(id);
		if( !device ){
			console.debug("Device online received with invalid data");
			return;
		}
		device.online = true;
		device.socket = socket;
		device.loadMeta(meta);

		this.onDeviceOnline( device );

		if( device.hasBatteryStatus() )
			this.getBattery(device);

	}

	handleDeviceOffline( data ){

		const id = data[0];
		let device = this.getDevice(id);
		if( !device )
			device = new VhDevice(id, this);	// It's asynchronous, so you can't rely on always having a device

		device.online = false;
		this.onDeviceOffline( device );

	}

	handleDeviceBattery( data ){

		const id = data.id;
		let device = this.getDevice(id);
		if( !device )
			device = new VhDevice(id, this);	// It's asynchronous, so you can't rely on always having a device
		device.batteryLow = data.low;
		device.batteryMillivolts = data.mv;
		device.batteryMaxMillivolts = data.xv;
		this.onDeviceBattery( device );

	}

	// This method lets us add one or more devices. deviceID is the device ID you get from your VibHub device
	// deviceID can be either a string or an array of strings
	// resolves with a VhDevice object
	async addDevice( deviceID ){
		if( !this.socket )
			return;

		return await new Promise(res => {

			this.socket.emit('hookup', deviceID, devices => {

				this.handleNewIndex(devices);
				res(this.getDevice(deviceID));

			});

		});
		
	}

	async remDevice( device ){

		return await new Promise(res => {

			this.socket.emit('hookdown', device.id, () => {

				this.handleNewIndex(devices);
				res();

			});

		});

		
	}

	// Clears all devices
	async wipeDevices(){

		if( !this.socket )
			return;

		return await new Promise(res => {

			this.socket.emit('hookdown', [], () => {

				this.devices = [];	// Update our array of devices. The index of the devices in this array is what we will use to send the updates.
				res();

			});

		});

	}


	// Returs a device by deviceID or undefined if not found
	getDevice( deviceID ){

		for( let device of this.devices ){
			
			if( device.id === deviceID )
				return device;

		}	

	}

	// Updates the vibration strength of a device's ports
	sendPWM( device ){
		
		let out = device.index.toString(16).padStart(2,'0'), // Start with the device index. This gets shifted off by the server.
			numChars = 2
		;
		if( device.isHighRes() ){
			out += '01'; // Add a single byte with bitwise value 0x01 to mark as high res (2 bytes per channel)
			numChars += 2;
		}


		for( let i = 0; i < device.numPorts; ++i )	// Add the intensitydevice.pwm )
			out += device.getChannelVal(i).toString(16).padStart(numChars,'0');

		this.socket.emit('p', out);	// Send the hex to the VibHub device!

	}

	sendSingleChannelPWM( device, ...channels ){

		const ch = [...channels];		

		let out = device.index.toString(16).padStart(2,'0');					// Device index
		for( let channel of ch ){

			let ch = parseInt(channel) || 0;
			const highRes = device.isHighRes();
			if( highRes )
				ch = ch|0x80; // Mark data as high res
			
			out += ch.toString(16).padStart(2, '0');					// Channel
			const numChars = 2 + (highRes*2);
			out += device.getChannelVal().toString(16).padStart(numChars, '0').substring(0,numChars);		// Intensity
			
		}
		this.socket.emit('ps', out);

	}

	// Takes a VhDevice object and VhProgram object
	sendProgram( device, program ){
		
		if( typeof program !== "object" || typeof program.export !== "function" )
			throw "Program is invalid";

		const prog = program.export(device);
		this.socket.emit('GET', {
			id : device.id,
			type : "vib",
			data : [prog],
			highres : device.isHighRes(),
		});

	}
	getBattery( device ){

		this.socket.emit("gb", {
			id : device.id,
		});

	}


	// Send a message to a modified VibHub device (must be connected to the app)
	sendCustomMessage( device, data ){
		this.socket.emit("dCustom", [device.id, data]);
	}


	tick(){

		this.onTick();
		for( let device of this.devices ){
			
			if( device.changed(true) ){
				
				this.sendPWM(device);

			}

		}

	}

	// makes sure SIO exists in the browser
	async _addScript(){
		
		if( !window.io ){
			
			return new Promise((res, rej) => {

				const sc = document.createElement('script');
				sc.onload = res;
				sc.src = this.server+'/socket.io/socket.io.js';
				document.head.appendChild(sc);

			});

		}

	}

}

class VhDevice{

	static CapabilityNames = {
		p : 'pwm batch',
		ps : 'pwm specific',
		ph : 'pwm specific high res',
		vib : 'programs',
		sb : 'battery status',
		app_offline : 'offline capabilities',
		dCustom : 'custom tasks',
		aCustom : 'custom events',
		h : 'high resolution'
	};

	constructor( deviceID, parent ){

		this.id = deviceID;
		this.index = 0;
		this.socket = '';	// Can be used for direct communication?

		this.pwm = [0,0,0,0];		// Floats
		this._pwm = [0,0,0,0];		// 16 bit values
		this._parent = parent;

		this.online = false;
		this.batteryLow = false;
		this.batteryMillivolts = 0;
		this.batteryMaxMillivolts = 0;
		this.numPorts = 0;
		this.version = '';
		this.custom = '';
		this.hwversion = '';
		this.capabilities = {};
		this.minPwm = 0;				// Float. Since devices generally need a duty cycle of like 100 to just about start to turn on, we will have programs auto recalculated to this min value unless the program value is 0.
		this._maxVal = 255;				// Cache of max val
		
	}

	// Enables high res mode
	setHighRes( on = true ){

		const hrb = this.getHiResBits();
		this._maxVal = Math.pow(2, hrb)-1;
		if( !hrb || !on )
			this._maxVal = 255;			

	}
	
	isHighRes(){
		return this._maxVal !== 255;
	}

	loadMeta( data ){

		if( parseInt(data.numPorts) )
			this.numPorts = parseInt(data.numPorts);	
		
		if( data.version )
			this.version = String(data.version);		
		
		if( data.custom )
			this.custom = String(data.custom);

		if( data.hwversion )
			this.hwversion = String(data.hwversion);

		if( typeof data.capabilities === "object" && data.capabilities )
			this.capabilities = data.capabilities;	

	}

	// Gets channel val taking min/max, and max val into consideration
	getChannelVal( ch = 0 ){

		return Math.trunc(this.calcMinPwm(this.pwm[ch])*this._maxVal);

	}

	calcMinPwm( input ){

		input = Math.abs(input) || 0;
		return (input*(1.0-this.minPwm))+this.minPwm;

	}

	// These 3 are supported on all devices we've put out. So if capabilities are empty, we can assume they are supported
	// Send vibrations directly on ALL ports
	hasCapPwmBasic(){
		return this.capabilities.p || !Object.keys(this.capabilities).length; 
	}
	// Set vibrations on specific ports
	hasCapPwmSpecific(){
		return this.capabilities.ps || !Object.keys(this.capabilities).length; 
	}
	// Run programs
	hasCapPrograms(){
		return this.capabilities.vib || !Object.keys(this.capabilities).length;
	}
	// Can do stuff while offline. Afaik, none of our devices support this. Only custom ones.
	hasCapOffline(){
		return this.capabilities.app_offline;
	}
	// Has a handler for custom methods sent from app to device
	hasCustomToDevice(){
		return this.capabilities.dCustom;
	}
	// Has a handler for custom methods sent from device to app
	hasCustomToApp(){
		return this.capabilities.aCustom;
	}
	// Has battery level and low power output
	hasBatteryStatus(){
		return this.capabilities.sb;
	}
	// Gets hi res cability bit size. Returns 0 if no high res capability is available
	getHiResBits(){
		return Math.trunc(this.capabilities.h) || 0; 
	}


	getCapabilityNames(){

		let out = [];
		for( let cap in this.capabilities ){

			if( VhDevice.CapabilityNames[cap] )
				out.push( VhDevice.CapabilityNames[cap] );

		}
		return out;
		
	}


	sendPWM(){
		this._parent.sendPWM( this );
	}

	sendSingleChannelPWM( ...channels ){
		this._parent.sendSingleChannelPWM( this, ...channels );
	}

	sendProgram( program ){
		this._parent.sendProgram( this, program );
	}

	// Attempts to fetch battery status
	getBattery(){

		this._parent.getBattery( this );

	}

	// Checks if PWM has changed. If stash is true, it stashes changes detected 
	changed( stash = false ){

		for( let i in this.pwm ){
			
			const val = this.pwm[i]*0xFFFF;
			if( val != this._pwm[i] ){
				
				if( stash )
					this.stashChange();
				return true;

			}

		}

	}

	// Syncs _pwm to pwm
	stashChange(){

		this._pwm = this.pwm.map(el => el*0xFFFF); // Convert to 16 bit values

	}

	set( val = 0, channel = -1 ){
		val = Math.abs(val);
		if( isNaN(val) )
			throw "Value is NaN";

		channel = parseInt(channel);

		val = Math.max(0, Math.min(1, val));

		for( let i = 0; i < this.pwm.length; ++i ){
			
			if( channel === -1 || channel === i )
				this.pwm[i] = val;
			
		}
		
	}

	setMinPwm( amt = 0 ){
		
		this.minPwm = Math.abs(amt) || 0;
		this.minPwm = Math.min(1, Math.max(0, this.minPwm));

	}

	async remove(){

		await this._parent.remove(this);

	}

}

// Program API
class VhProgram{

	// Ports is an array of ports you want to trigger, numbered from 0 to 3
	// Ports can also be a single port if it's an int
	constructor( ports, repeats = 0 ){

		this.port = 0;
		this.repeats = repeats > 0 ? parseInt(repeats) : 0;
		this.stages = [];

		this.setPorts(ports);

	}

	// Accepts an array of ports to set or an integer
	setPorts( ports ){

		if( !Array.isArray(ports) ){

			if( !isNaN(ports) )
				this.port = parseInt(ports);
			return;

		}

		this.port = 0;
		for( let port of ports ){
			
			if( port < 0 || port > 3 )
				continue;
			port = Math.floor(port);
			this.port = this.port | (1<<port);

		}

	}

	// Adds one or more VhStages
	addStage( ...args ){

		for( let stage of [...args] )
			this.stages.push(stage);

	}

	export( device ){

		const out = {
			stages : []
		};
		if( this.port > 0 )
			out.port = this.port;
		if( this.repeats > 0 )
			out.repeats = this.repeats;

		if( !Array.isArray(this.stages) )
			throw "Program stages is not an array";
		
		
		for( let stage of this.stages ){

			if( typeof stage !== "object" || typeof stage.export !== "function" )
				throw "A stage is not a proper object";

			let ex = stage.export(device);
			if( typeof ex !== "object" )
				throw "Invalid stage export";

			out.stages.push(ex);

		}

		return out;
		
	}

}

class VhStage{


	constructor( settings = {} ){

		if( typeof settings !== "object" )
			settings = {};

		// Intensity is stored as 16 bit internally
		this.intensity = Math.max(0, Math.min(1, settings.intensity)) || 0;
		if( settings.intensity instanceof VhRandObject )
			this.intensity = settings.intensity;

		this.duration = parseInt(settings.duration) || 0;
		if( settings.duration instanceof VhRandObject )
			this.duration = settings.duration;

		this.easing = settings.easing || "Linear.None";

		this.repeats = parseInt(settings.repeats) || 0;
		if( settings.repeats instanceof VhRandObject )
			this.repeats = settings.repeats;

		this.yoyo = Boolean(settings.yoyo);

	}

	exportFloatOrRand( v, device ){
		
		if( typeof v === "object" && typeof v.export === "function" )
			return v.export(device);

		if( !isNaN(v) )
			return Math.abs(v);
			
		return 0;

	}

	export( device ){

		let out = {};
		if( typeof this.intensity === "boolean" )
			out.i = this.intensity;
		else if( this.intensity )
			out.i = this.exportFloatOrRand(this.intensity, device);

		if( this.repeats )
			out.r = this.exportFloatOrRand(this.repeats, device);

		if( this.duration )
			out.d = this.exportFloatOrRand(this.duration, device);

		if( typeof this.easing === "string" && this.easing !== "Linear.None" )
			out.e = this.easing;
		
		if( this.yoyo )
			out.y = this.yoyo;

		// Numeric needs to adhere to device rules
		if( typeof out.i === "number" ){
			out.i = device.calcMinPwm(out.i);
			out.i *= device._maxVal;
			out.i = Math.round(out.i);
		}

		return out;

	}

}

class VhRandObject{

	constructor( settings = {} ){
		
		if( typeof settings !== "object" )
			settings = {};

		this.min = (+settings.min) || 0;
		this.max = (+settings.max) || 0;
		this.offset = (+settings.offset) || 0;
		this.multi = (+settings.multi) || 0;

	}

	export( device ){

		let out = {};
		if( this.min !== null )
			out.min = device.calcMinPwm(this.min)*device._maxVal || 0;
		if( this.max !== null )
			out.max = device.calcMinPwm(this.max)*device._maxVal || 0;
		if( this.offset !== null )
			out.offset = this.offset;
		if( this.multi !== null )
			out.multi = this.multi;
		return out;

	}

}



export default VhSocket;
export {VhProgram, VhStage, VhRandObject};
