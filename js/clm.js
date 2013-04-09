//requires: jsfeat, numeric.js

var clm = {
	tracker : function(params) {
		
		if (!params) params = {};
		if (params.constantVelocity === undefined) params.constantVelocity = true;
		if (params.searchWindow === undefined) params.searchWindow = 10;
		if (params.useWebGL === undefined) params.useWebGL = true;
		if (params.scoreThreshold === undefined) params.scoreThreshold = 0.4;
		
		var numPatches, patchSize, numParameters, patchType;
		var gaussianPD;
		var eigenVectors, eigenValues;
		var sketchCC, sketchW, sketchH, sketchCanvas;
		var candidate;
		
		var currentParameters = [];
		var currentPositions = [];
		var previousParameters = [];
		
		var weightMatrices = [];
		var weightMatricesOld = [];
		var weights = [];
		
		var patches = [];
		var responses = [];
		var meanShape = [];
		
		var movementSums = [];
		
		/*
		It's possible to experiment with the sequence of variances used for the finding the maximum in the KDE.
		This sequence is pretty arbitrary, but was found to be okay using some manual testing.
		In Saragih's paper he used the sequence [20,10,5,1], this was however found to be slower and equally precise.
		*/
		//var varianceSeq = [10,7,5];
		var varianceSeq = [3,1.5,0.75];
		
		/*
		The PDM variance determines how the PDM models parameters can vary when fitting.
		A low variance puts very little constraint on the parameters, a high variance puts a lot of constraint.
		According to the formula in Saragih's paper, this parameter should be around 0.00005, however a higher variance was found to work better for this model.
		*/
		var PDMVariance = 0.05;
		
		var relaxation = 0.1;
		
		var first = true;
		
		var convergenceLimit = 0.01;
		
		var learningRate = [];
		var stepParameter = 1.25;
		var prevCostFunc = []
		
		var searchWindow;
		var modelWidth, modelHeight;
		
		var halfSearchWindow, vecProbs, responsePixels;
		if(typeof Float64Array !== 'undefined') {
			var updatePosition = new Float64Array(2);
			var vecpos = new Float64Array(2);
		} else {
			var updatePosition = new Array(2);
			var vecpos = new Array(2);
		}
		var pw, pl, pdataLength;
			
		if (pModel.hints && mosseFilter && left_eye_filter && right_eye_filter && nose_filter) {
			//var mossef_lefteye = new mosseFilter({drawResponse : document.getElementById('overlay2')});
			var mossef_lefteye = new mosseFilter();
			mossef_lefteye.load(left_eye_filter);
			//var mossef_righteye = new mosseFilter({drawResponse : document.getElementById('overlay2')});
			var mossef_righteye = new mosseFilter();
			mossef_righteye.load(right_eye_filter);
			//var mossef_nose = new mosseFilter({drawResponse : document.getElementById('overlay2')});
			var mossef_nose = new mosseFilter();
			mossef_nose.load(nose_filter);
			
			var right_eye_position = [0.0,0.0];
			var left_eye_position = [0.0,0.0];
			var nose_position = [0.0,0.0];
			var lep, rep, mep;
		} else {
			console.log("MOSSE filters not found, using rough approximation for initialization.");
		}
		var facecheck_count = 0;
		
		var webglFi, svmFi, mosseCalc;

		var scoringCanvas = document.createElement('canvas');
		//document.body.appendChild(scoringCanvas);
		// TODO : scoringcanvas width & height should be from model
		scoringCanvas.width = 20;
		scoringCanvas.height = 22;
		var scoringContext = scoringCanvas.getContext('2d');
		var msxmin, msymin, msxmax, msymax;
		var msmodelwidth, msmodelheight;
		var scoringWeights, scoringBias;
		var scoringHistory = [];
		var meanscore = 0;
			
		this.init = function(canvas) {
			// do all prep stuff
			
			sketchCanvas = canvas;
			sketchCC = canvas.getContext('2d');
			sketchW = canvas.width;
			sketchH = canvas.height;
			
			// load from model
			patchType = pModel.patchModel.patchType;
			numPatches = pModel.patchModel.numPatches;
			patchSize = pModel.patchModel.patchSize[0];
			if (patchType == "MOSSE") {
				searchWindow = patchSize;
			} else {
				searchWindow = params.searchWindow;
			}
			numParameters = pModel.shapeModel.numEvalues;
			modelWidth = pModel.patchModel.canvasSize[0];
			modelHeight = pModel.patchModel.canvasSize[1];
			
			// load eigenvectors
			eigenVectors = numeric.rep([numPatches*2,numParameters],0.0);
			for (var i = 0;i < numPatches*2;i++) {
				for (var j = 0;j < numParameters;j++) {
					eigenVectors[i][j] = pModel.shapeModel.eigenVectors[i][j];
				}
			}
			
			// load mean shape
			for (var i = 0; i < numPatches;i++) {
				meanShape[i] = [pModel.shapeModel.meanShape[i][0], pModel.shapeModel.meanShape[i][1]];
			}

			// get max and mins, width and height of meanshape
			msxmax = msymax = 0;
			msxmin = msymin = 1000000;
			for (var i = 0;i < numPatches;i++) {
				if (meanShape[i][0] < msxmin) msxmin = meanShape[i][0];
				if (meanShape[i][1] < msymin) msymin = meanShape[i][1];
				if (meanShape[i][0] > msxmax) msxmax = meanShape[i][0];
				if (meanShape[i][1] > msymax) msymax = meanShape[i][1];
			}
			msmodelwidth = msxmax-msxmin;
			msmodelheight = msymax-msymin;
			
			// get scoringweights if they exist
			if (pModel.scoring) {
				scoringWeights = new Float64Array(pModel.scoring.coef);
				scoringBias = pModel.scoring.bias;
			}
			
			// load eigenvalues
			eigenValues = pModel.shapeModel.eigenValues;
			
			weights = pModel.patchModel.weights;
			
			// precalculate gaussianPriorDiagonal
			gaussianPD = numeric.rep([numParameters+4, numParameters+4],0);
			// set values and append manual inverse
			for (var i = 0;i < numParameters;i++) {
				if (pModel.shapeModel.nonRegularizedVectors.indexOf(i) >= 0) {
					gaussianPD[i+4][i+4] = 1/10000000;
				} else {
					gaussianPD[i+4][i+4] = 1/eigenValues[i];
				}
			}
			
			for (var i = 0;i < numParameters+4;i++) {
				currentParameters[i] = 0;
			}
			
			if (patchType == "SVM") {
				var webGLContext;
				var webGLTestCanvas = document.createElement('canvas');
				if (window.WebGLRenderingContext) {
					webGLContext = webGLTestCanvas.getContext('webgl') || webGLTestCanvas.getContext('experimental-webgl');
					if (!webGLContext || !webGLContext.getExtension('OES_texture_float')) {
						webGLContext = null;
					}
				} 
				
				if (webGLContext && params.useWebGL && (typeof(webglFilter) !== "undefined")) {
					webglFi = new webglFilter();
					webglFi.init(weights, numPatches, searchWindow+patchSize, searchWindow+patchSize, patchSize, patchSize, true);
				} else if (typeof(svmFilter) !== "undefined") {
					// use fft convolution if no webGL is available
					svmFi = new svmFilter();
					svmFi.init(weights, numPatches, patchSize, searchWindow);
				} else {
					throw "Could not initiate filters, please make sure that svmfilter.js or svmfilter_conv_js.js is loaded."
				}
			} else if (patchType == "MOSSE") {
				mosseCalc = new mosseFilterResponses();
				mosseCalc.init(weights, numPatches, patchSize, patchSize);
			}
			
			if (patchType == "SVM") {
				pw = pl = patchSize+searchWindow;
			} else {
				pw = pl = searchWindow;
			}
			pdataLength = pw*pl;
			halfSearchWindow = searchWindow/2;
			responsePixels = searchWindow*searchWindow;
			if(typeof Float64Array !== 'undefined') {
				vecProbs = new Float64Array(responsePixels);
				for (var i = 0;i < numPatches;i++) {
					patches[i] = new Float64Array(pdataLength);
				}
			} else {
				vecProbs = new Array(responsePixels);
				for (var i = 0;i < numPatches;i++) {
					patches[i] = new Array(pdataLength);
				}
			}
			
			for (var i = 0;i < numPatches;i++) {
				learningRate[i] = 1.0;
				prevCostFunc[i] = 0.0;
			}
		}
		
		var createJacobian = function(parameters, eigenVectors) {
			// generates the jacobian matrix
			
			var jacobian = numeric.rep([2*numPatches, numParameters+4],0.0);
			var j0,j1;
			for (var i = 0;i < numPatches;i ++) {
				// 1
				j0 = meanShape[i][0];
				j1 = meanShape[i][1];
				for (var p = 0;p < numParameters;p++) {
					j0 += parameters[p+4]*eigenVectors[i*2][p];
					j1 += parameters[p+4]*eigenVectors[(i*2)+1][p];
				}
				jacobian[i*2][0] = j0;
				jacobian[(i*2)+1][0] = j1;
				// 2
				j0 = meanShape[i][1];
				j1 = meanShape[i][0];
				for (var p = 0;p < numParameters;p++) {
					j0 += parameters[p+4]*eigenVectors[(i*2)+1][p];
					j1 += parameters[p+4]*eigenVectors[i*2][p];
				}
				jacobian[i*2][1] = -j0;
				jacobian[(i*2)+1][1] = j1;
				// 3
				jacobian[i*2][2] = 1;
				jacobian[(i*2)+1][2] = 0;
				// 4
				jacobian[i*2][3] = 0;
				jacobian[(i*2)+1][3] = 1;
				// the rest
				for (var j = 0;j < numParameters;j++) {
					j0 = parameters[0]*eigenVectors[i*2][j] - parameters[1]*eigenVectors[(i*2)+1][j] + eigenVectors[i*2][j];
					j1 = parameters[0]*eigenVectors[(i*2)+1][j] + parameters[1]*eigenVectors[i*2][j] + eigenVectors[(i*2)+1][j];
					jacobian[i*2][j+4] = j0;
					jacobian[(i*2)+1][j+4] = j1;
				}
			}
			
			return jacobian;
		}
		
		var calculatePositions = function(parameters, useTransforms) {
			var x, y, a, b;
			var numParameters = parameters.length;
			var positions = [];
			for (var i = 0;i < numPatches;i++) {
				x = meanShape[i][0];
				y = meanShape[i][1];
				for (var j = 0;j < numParameters-4;j++) {
					x += pModel.shapeModel.eigenVectors[(i*2)][j]*parameters[j+4];
					y += pModel.shapeModel.eigenVectors[(i*2)+1][j]*parameters[j+4];
				}
				if (useTransforms) {
					a = parameters[0]*x - parameters[1]*y + parameters[2];
					b = parameters[0]*y + parameters[1]*x + parameters[3];
					x += a;
					y += b;
				}
				positions[i] = [x,y];
			}
			
			return positions;
		}
		
		this.calculatePositions = function(parameters) {
			return calculatePositions(parameters, true);
		}
		
		var detectPosition = function(el) {
			var canvas = document.createElement('canvas');
			canvas.width = el.width;
			canvas.height = el.height;
			var cc = canvas.getContext('2d');
			cc.drawImage(el, 0, 0, el.width, el.height);
			
			// do viola-jones on canvas to get initial guess, if we don't have any points
			/*var comp = ccv.detect_objects(
				ccv.grayscale(canvas), ccv.cascade, 5, 1
			);*/
			var jf = new jsfeat_face(canvas);
			var comp = jf.findFace(1);
			
			if (comp.length > 0) {
				candidate = comp[0];
			} else {
				return false;
			}
			
			/*for (var i = 1; i < comp.length; i++) {
				if (comp[i].confidence > candidate.confidence) {
					candidate = comp[i];
				}
			}*/
			
			return candidate;
		}
		
		this.getCurrentPosition = function() {
			return currentPositions;
		}
		
		this.getCurrentParameters = function() {
			return currentParameters;
		}
		
		var gpopt = function(responseWidth, currentPositionsj, updatePosition, vecProbs, responses, opj0, opj1, j, variance) {
			var pos_idx = 0;
			var vpsum = 0;
			var dx, dy;
			for (var k = 0;k < responseWidth;k++) {
				updatePosition[1] = opj1+k;
				for (var l = 0;l < responseWidth;l++) {
					updatePosition[0] = opj0+l;
					
					dx = currentPositionsj[0] - updatePosition[0];
					dy = currentPositionsj[1] - updatePosition[1];
					vecProbs[pos_idx] = responses[j][pos_idx] * Math.exp(-0.5*((dx*dx)+(dy*dy))/variance);
					
					vpsum += vecProbs[pos_idx];
					pos_idx++;
				}
			}
			
			return vpsum;
		}
	
		var gpopt2 = function(responseWidth, vecpos, updatePosition, vecProbs, vpsum, opj0, opj1) {
			//for debugging
			//var vecmatrix = [];
			
			var pos_idx = 0;
			var vecsum = 0;
			vecpos[0] = 0;
			vecpos[1] = 0;
			for (var k = 0;k < responseWidth;k++) {
				updatePosition[1] = opj1+k;
				for (var l = 0;l < responseWidth;l++) {
					updatePosition[0] = opj0+l;
					vecsum = vecProbs[pos_idx]/vpsum;
					
					//for debugging
					//vecmatrix[k*responseWidth + l] = vecsum;
					
					vecpos[0] += vecsum*updatePosition[0];
					vecpos[1] += vecsum*updatePosition[1];
					pos_idx++;
				}
			}
			// for debugging
			//return vecmatrix;
		}
		
		var checkTracking = function() {			
			scoringContext.drawImage(sketchCanvas, msxmin, msymin, msmodelwidth, msmodelheight, 0, 0, 20, 22);
			// getImageData of canvas
			var imgData = scoringContext.getImageData(0,0,20,22);
			// convert data to grayscale
			var scoringData = new Array(20*22);
			var scdata = imgData.data;
			var scmax = 0;
			var scmin = 255;
			for (var i = 0;i < 20*22;i++) {
			  scoringData[i] = scdata[i*4]*0.3 + scdata[(i*4)+1]*0.59 + scdata[(i*4)+2]*0.11;
			  if (scoringData[i] > scmax) scmax = scoringData[i];
			  if (scoringData[i] < scmin) scmin = scoringData[i];
			}
			
			if (scmax > 0) {
				// normalize & multiply by svmFilter
				var score = 0;
				var newim = scoringContext.createImageData(20,22);
				var newimdata = newim.data;
				var scdaata = new Array(20*22);
				var scdamin = 10000000;
				var scdamax = -10000000;
				for (var i = 0;i < 20*22;i++) {
					scoringData[i] = (scoringData[i]-scmin)/(scmax-scmin);
					scdaata[i] = scoringData[i]*scoringWeights[i];
					if (scdaata[scdamin] < i) scdamin = scdaata[i];
					if (scdaata[i] > scdamax) scdamax = scdaata[i];
				}

				for (var i = 0;i < 20*22;i++) {
					var nid = 255*((scdaata[i]-scdamin)/(scdamax-scdamin));
					newimdata[i*4] = nid;
					newimdata[(i*4)+1] = nid;
					newimdata[(i*4)+2] = nid;
					newimdata[(i*4)+3] = 255;
				}
				scoringContext.putImageData(newim,0,0);

				for (var i = 0;i < 20*22;i++) {
					score += (scoringData[i])*-scoringWeights[i];
				}
				score += scoringBias;

				scoringHistory.splice(0, scoringHistory.length == 5 ? 1 : 0);
				scoringHistory.push(score);

				if (scoringHistory.length > 4) {
					// get average
					meanscore = 0;
					for (var i = 0;i < 5;i++) {
						meanscore += scoringHistory[i];
					}
					meanscore /= 5;
					// if below threshold, then reset (return false)
					if (meanscore < params.scoreThreshold) return false;
				}
			}
			return true;
		}

		this.getScore = function() {
			return meanscore;
		}
		
		var getInitialPosition = function(element) {
			var det = detectPosition(element);
			if (!det) {
			// if no face found, stop.
			return false;
			}
			
			if (pModel.hints && mosseFilter && left_eye_filter && right_eye_filter && nose_filter) {
				var noseFilterWidth = candidate.width * 4.5/10;
				var eyeFilterWidth = candidate.width * 6/10;
				//var eyeFilterWidth = candidate.width * 4.5/10;
				
				// detect position of eyes and nose via mosse filter
				//element.pause();
				
				/*var canvasContext = document.getElementById('overlay2').getContext('2d')
				canvasContext.clearRect(0,0,320,240);
				canvasContext.strokeRect(candidate.x, candidate.y, candidate.width, candidate.height);*/
				
				var nose_result = mossef_nose.track(element, Math.round(candidate.x+(candidate.width/2)-(noseFilterWidth/2)), Math.round(candidate.y+candidate.height*(5/8)-(noseFilterWidth/2)), noseFilterWidth, noseFilterWidth, false);
				var right_result = mossef_righteye.track(element, Math.round(candidate.x+(candidate.width*3/4)-(eyeFilterWidth/2)), Math.round(candidate.y+candidate.height*(2/5)-(eyeFilterWidth/2)), eyeFilterWidth, eyeFilterWidth, false);
				var left_result = mossef_lefteye.track(element, Math.round(candidate.x+(candidate.width/4)-(eyeFilterWidth/2)), Math.round(candidate.y+candidate.height*(2/5)-(eyeFilterWidth/2)), eyeFilterWidth, eyeFilterWidth, false);
				//var nose_result = mossef_nose.track(element, Math.round(candidate.x+(candidate.width/2)-(noseFilterWidth/2)), Math.round(candidate.y+candidate.height*(3/4)-(noseFilterWidth/2)), noseFilterWidth, noseFilterWidth, false);
				right_eye_position[0] = Math.round(candidate.x+(candidate.width*3/4)-(eyeFilterWidth/2))+right_result[0];
				right_eye_position[1] = Math.round(candidate.y+candidate.height*(2/5)-(eyeFilterWidth/2))+right_result[1];
				left_eye_position[0] = Math.round(candidate.x+(candidate.width/4)-(eyeFilterWidth/2))+left_result[0];
				left_eye_position[1] = Math.round(candidate.y+candidate.height*(2/5)-(eyeFilterWidth/2))+left_result[1];
				//nose_position[0] = Math.round(candidate.x+(candidate.width/2)-(noseFilterWidth/2))+nose_result[0];
				//nose_position[1] = Math.round(candidate.y+candidate.height*(3/4)-(noseFilterWidth/2))+nose_result[1];
				nose_position[0] = Math.round(candidate.x+(candidate.width/2)-(noseFilterWidth/2))+nose_result[0];
				nose_position[1] = Math.round(candidate.y+candidate.height*(5/8)-(noseFilterWidth/2))+nose_result[1];
				
				/*canvasContext.strokeRect(Math.round(candidate.x+(candidate.width*3/4)-(eyeFilterWidth/2)), Math.round(candidate.y+candidate.height*(2/5)-(eyeFilterWidth/2)), eyeFilterWidth, eyeFilterWidth);
				canvasContext.strokeRect(Math.round(candidate.x+(candidate.width/4)-(eyeFilterWidth/2)), Math.round(candidate.y+candidate.height*(2/5)-(eyeFilterWidth/2)), eyeFilterWidth, eyeFilterWidth);
				//canvasContext.strokeRect(Math.round(candidate.x+(candidate.width/2)-(noseFilterWidth/2)), Math.round(candidate.y+candidate.height*(3/4)-(noseFilterWidth/2)), noseFilterWidth, noseFilterWidth);
				canvasContext.strokeRect(Math.round(candidate.x+(candidate.width/2)-(noseFilterWidth/2)), Math.round(candidate.y+candidate.height*(5/8)-(noseFilterWidth/2)), noseFilterWidth, noseFilterWidth);
				
				canvasContext.fillStyle = "rgb(0,0,250)";
				canvasContext.beginPath();
				canvasContext.arc(left_eye_position[0], left_eye_position[1], 3, 0, Math.PI*2, true);
				canvasContext.closePath();
				canvasContext.fill();
				
				canvasContext.beginPath();
				canvasContext.arc(right_eye_position[0], right_eye_position[1], 3, 0, Math.PI*2, true);
				canvasContext.closePath();
				canvasContext.fill();
				
				canvasContext.beginPath();
				canvasContext.arc(nose_position[0], nose_position[1], 3, 0, Math.PI*2, true);
				canvasContext.closePath();
				canvasContext.fill();
				
				debugger;
				canvasContext.clearRect(0,0,320,240);*/
				
				// get eye and nose positions of model
				var lep = pModel.hints.leftEye;
				var rep = pModel.hints.rightEye;
				var mep = pModel.hints.nose;
				
				// get scaling, rotation, etc. via procrustes analysis
				var procrustes_params = procrustes([left_eye_position, right_eye_position, nose_position], [lep, rep, mep]);
				translateX = procrustes_params[0];
				translateY = procrustes_params[1];
				scaling = procrustes_params[2];
				rotation = procrustes_params[3];
				//debugger;
				//element.play();
				
				//var maxscale = 1.10;
				//if ((scaling*modelHeight)/candidate.height < maxscale*0.7) scaling = (maxscale*0.7*candidate.height)/modelHeight;
				//if ((scaling*modelHeight)/candidate.height > maxscale*1.2) scaling = (maxscale*1.2*candidate.height)/modelHeight;
				
				/*var smean = [0,0];
				smean[0] += lep[0];
				smean[1] += lep[1];
				smean[0] += rep[0];
				smean[1] += rep[1];
				smean[0] += mep[0];
				smean[1] += mep[1];
				smean[0] /= 3;
				smean[1] /= 3;
				
				var nulep = [(lep[0]*scaling*Math.cos(-rotation)+lep[1]*scaling*Math.sin(-rotation))+translateX, (lep[0]*scaling*(-Math.sin(-rotation)) + lep[1]*scaling*Math.cos(-rotation))+translateY];
				var nurep = [(rep[0]*scaling*Math.cos(-rotation)+rep[1]*scaling*Math.sin(-rotation))+translateX, (rep[0]*scaling*(-Math.sin(-rotation)) + rep[1]*scaling*Math.cos(-rotation))+translateY];
				var numep = [(mep[0]*scaling*Math.cos(-rotation)+mep[1]*scaling*Math.sin(-rotation))+translateX, (mep[0]*scaling*(-Math.sin(-rotation)) + mep[1]*scaling*Math.cos(-rotation))+translateY];
				
				canvasContext.fillStyle = "rgb(200,10,100)";
				canvasContext.beginPath();
				canvasContext.arc(nulep[0], nulep[1], 3, 0, Math.PI*2, true);
				canvasContext.closePath();
				canvasContext.fill();
				
				canvasContext.beginPath();
				canvasContext.arc(nurep[0], nurep[1], 3, 0, Math.PI*2, true);
				canvasContext.closePath();
				canvasContext.fill();
				
				canvasContext.beginPath();
				canvasContext.arc(numep[0], numep[1], 3, 0, Math.PI*2, true);
				canvasContext.closePath();
				canvasContext.fill();*/
				
				currentParameters[0] = (scaling*Math.cos(rotation))-1;
				currentParameters[1] = (scaling*Math.sin(rotation));
				currentParameters[2] = translateX;
				currentParameters[3] = translateY;
				
				//this.draw(document.getElementById('overlay'), currentParameters);
				
			} else {
				scaling = candidate.width/modelheight;
				var ccc = document.getElementById('overlay').getContext('2d');
				ccc.strokeRect(candidate.x,candidate.y,candidate.width,candidate.height);
				translateX = candidate.x-(xmin*scaling)+0.1*candidate.width;
				translateY = candidate.y-(ymin*scaling)+0.25*candidate.height;
				currentParameters[0] = scaling-1;
				currentParameters[2] = translateX;
				currentParameters[3] = translateY;
			}
		
			currentPositions = calculatePositions(currentParameters, true);
			
			return true;
		}
		
		/*
		 *  element : canvas or video element
		 *  TODO: should be able to take img element as well
		 */
		this.track = function(element) {
			
			var scaling, translateX, translateY, rotation;
			var croppedPatches = [];
			var ptch, px, py;
			
			if (first) {
				// do viola-jones on canvas to get initial guess, if we don't have any points
				debugger;
				var gi = getInitialPosition(element);
				if (!gi) {
					return false;
				}
				
				first = false;
			} else {
				facecheck_count += 1;
				
				// TODO : do cross-correlation/correlation-filter or similar to find translation of face
				if (params.constantVelocity) {
					// calculate where to get patches via constant velocity prediction
					if (previousParameters.length >= 2) {
						for (var i = 0;i < currentParameters.length;i++) {
							currentParameters[i] = (relaxation)*previousParameters[1][i] + (1-relaxation)*((2*previousParameters[1][i]) - previousParameters[0][i]);
							//currentParameters[i] = (3*previousParameters[2][i]) - (3*previousParameters[1][i]) + previousParameters[0][i];
						}
					}
				}
				
				// change translation, rotation and scale parameters
				scaling = 1+currentParameters[0];
				translateX = currentParameters[2];
				translateY = currentParameters[3];
			}
			
			// copy canvas to a new dirty canvas
			sketchCC.save();
			
			// clear canvas
			sketchCC.clearRect(0, 0, sketchW, sketchH);
			
			sketchCC.scale(1/scaling, 1/scaling);
			sketchCC.rotate(-Math.asin(currentParameters[1]/scaling));
			sketchCC.translate(-translateX, -translateY);
			
			sketchCC.drawImage(element, 0, 0, element.width, element.height);
			
			sketchCC.restore();
			//	get cropped images around new points based on model parameters (not scaled and translated)
			var patchPositions = calculatePositions(currentParameters, false);
			
			// check whether tracking is ok
			if (scoringWeights && (facecheck_count % 10 == 0)) {
				if (!checkTracking()) {
					first = true;
					scoringHistory = [];
					for (var i = 0;i < currentParameters.length;i++) {
						currentParameters[i] = 0;
						previousParameters = [];
					}
					return false;
				}
			}


			var pdata, pmatrix, grayscaleColor;
			for (var i = 0; i < numPatches; i++) {
				px = patchPositions[i][0]-(pw/2);
				py = patchPositions[i][1]-(pl/2);
				ptch = sketchCC.getImageData(px >> 0, py >> 0, pw, pl);
				pdata = ptch.data;
				
				// convert to grayscale
				pmatrix = patches[i];
				for (var j = 0;j < pdataLength;j++) {
					grayscaleColor = pdata[j*4]*0.3 + pdata[(j*4)+1]*0.59 + pdata[(j*4)+2]*0.11;
					pmatrix[j] = grayscaleColor;
				}
			}
			
			/*print weights*/
			/*sketchCC.clearRect(0, 0, sketchW, sketchH);
			var nuWeights;
			for (var i = 0;i < numPatches;i++) {
				nuWeights = weights[i].map(function(x) {return x*2000+127;});
				drawData(sketchCC, nuWeights, patchSize, patchSize, false, patchPositions[i][0]-(patchSize/2), patchPositions[i][1]-(patchSize/2));
			}*/
			
			// print patches
			/*sketchCC.clearRect(0, 0, sketchW, sketchH);
			for (var i = 0;i < numPatches;i++) {
				drawData(sketchCC, patches[i], pw, pl, false, patchPositions[i][0]-(pw/2), patchPositions[i][1]-(pl/2));
			}*/
			
			if (patchType == "SVM") {
				if (typeof(webglFi) !== "undefined") {
					var responses = webglFi.getResponses(patches, true);
				} else if (typeof(svmFi) !== "undefined"){
					var responses = svmFi.getResponses(patches);
				} else {
					throw "SVM-filters do not seem to be initiated properly."
				}
			} else if (patchType == "MOSSE") {
				var responses = mosseCalc.getResponses(patches);
			}
			
			// print responses
			/*sketchCC.clearRect(0, 0, sketchW, sketchH);
			var nuWeights;
			for (var i = 0;i < numPatches;i++) {
				nuWeights = responses[i].map(function(x) {return x*255});
				drawData(sketchCC, nuWeights, searchWindow, searchWindow, false, patchPositions[i][0]-(searchWindow/2), patchPositions[i][1]-(searchWindow/2));
			}*/
			
			// iterate until convergence or max 10, 20 iterations?:
			var originalPositions = currentPositions;
			var jac;
			var meanshiftVectors = [];
			
			for (var i = 0; i < varianceSeq.length; i++) {
				
				// calculate jacobian
				jac = createJacobian(currentParameters, eigenVectors);

				// for debugging
				//var debugMVs = [];
				//
				
				var opj0, opj1;
				
				for (var j = 0;j < numPatches;j++) {
					
					opj0 = originalPositions[j][0]-halfSearchWindow;
					opj1 = originalPositions[j][1]-halfSearchWindow;
					
					// calculate PI x gaussians
					var vpsum = gpopt(searchWindow, currentPositions[j], updatePosition, vecProbs, responses, opj0, opj1, j, varianceSeq[i]);
					
					// calculate meanshift-vector
					gpopt2(searchWindow, vecpos, updatePosition, vecProbs, vpsum, opj0, opj1);
					
					// for debugging
					//var debugMatrixMV = gpopt2(searchWindow, vecpos, updatePosition, vecProbs, vpsum, opj0, opj1);
					
					// evaluate here whether to increase/decrease stepSize
					/*if (vpsum >= prevCostFunc[j]) {
						learningRate[j] *= stepParameter;
					} else {
						learningRate[j] = 1.0;
					}
					prevCostFunc[j] = vpsum;*/
					
					// compute mean shift vectors
					// extrapolate meanshiftvectors
					/*var msv = [];
					msv[0] = learningRate[j]*(vecpos[0] - currentPositions[j][0]);
					msv[1] = learningRate[j]*(vecpos[1] - currentPositions[j][1]);
					meanshiftVectors[j] = msv;*/
					meanshiftVectors[j] = [vecpos[0] - currentPositions[j][0], vecpos[1] - currentPositions[j][1]];
					
					//if (isNaN(msv[0]) || isNaN(msv[1])) debugger;
					
					//for debugging
					//debugMVs[j] = debugMatrixMV;
					//
				}
				
				// draw meanshiftVector
				/*sketchCC.clearRect(0, 0, sketchW, sketchH);
				var nuWeights;
				for (var npidx = 0;npidx < numPatches;npidx++) {
					nuWeights = debugMVs[npidx].map(function(x) {return x*255*500;});
					drawData(sketchCC, nuWeights, searchWindow, searchWindow, false, patchPositions[npidx][0]-(searchWindow/2), patchPositions[npidx][1]-(searchWindow/2));
				}*/
				
				var meanShiftVector = numeric.rep([numPatches*2, 1],0.0);
				for (var k = 0;k < numPatches;k++) {
					meanShiftVector[k*2][0] = meanshiftVectors[k][0];
					meanShiftVector[(k*2)+1][0] = meanshiftVectors[k][1];
				}
				
				// compute pdm parameter update
				//var prior = numeric.mul(gaussianPD, PDMVariance);
				var prior = numeric.mul(gaussianPD, varianceSeq[i]);
				var jtj = numeric.dot(numeric.transpose(jac), jac);
				var cpMatrix = numeric.rep([numParameters+4, 1],0.0);
				for (var l = 0;l < (numParameters+4);l++) {
					cpMatrix[l][0] = currentParameters[l];
				}
				var priorP = numeric.dot(prior, cpMatrix);
				var jtv = numeric.dot(numeric.transpose(jac), meanShiftVector);
				var paramUpdateLeft = numeric.add(prior, jtj);
				var paramUpdateRight = numeric.sub(priorP, jtv);
				var paramUpdate = numeric.dot(numeric.inv(paramUpdateLeft), paramUpdateRight);
				
				var oldPositions = currentPositions;
				
				// update estimated parameters
				for (var k = 0;k < numParameters+4;k++) {
					currentParameters[k] -= paramUpdate[k];
				}
				
				// clipping of parameters if they're too high
				var clip;
				for (var k = 0;k < numParameters;k++) {
					clip = Math.abs(3*Math.sqrt(eigenValues[k]));
					if (Math.abs(currentParameters[k+4]) > clip) {
						if (currentParameters[k+4] > 0) {
							currentParameters[k+4] = clip;
						} else {
							currentParameters[k+4] = -clip;
						}
					}
				}
				
				// update current coordinates
				currentPositions = calculatePositions(currentParameters, true);
				
				// check if converged
				// calculate norm of parameterdifference
				var positionNorm = 0;
				var pnsq_x, pnsq_y;
				for (var k = 0;k < currentPositions.length;k++) {
					pnsq_x = (currentPositions[k][0]-oldPositions[k][0]);
					pnsq_y = (currentPositions[k][1]-oldPositions[k][1]);
					positionNorm += ((pnsq_x*pnsq_x) + (pnsq_y*pnsq_y));
				}
				//console.log("positionnorm:"+positionNorm);
				
				// if norm < limit, then break
				if (positionNorm < convergenceLimit) {
					break;
				}
			
			}
			
			if (params.constantVelocity) {
				// add current parameter to array of previous parameters
				previousParameters.push(currentParameters.slice());
				previousParameters.splice(0, previousParameters.length == 3 ? 1 : 0);
			}
			
			// get the sum of the movements, for checking convergence
			var movementSum = 0;
			var mssq_x, mssq_y;
			for (var i = 0;i < originalPositions.length;i++) {
			  mssq_x = (originalPositions[i][0]-oldPositions[i][0]);
			  mssq_y = (originalPositions[i][1]-oldPositions[i][1]);
			  movementSum += ((mssq_x*mssq_x) + (mssq_y*mssq_y));
			}
			movementSums.splice(0, movementSums.length == 10 ? 1 : 0);
			movementSums.push(movementSum);
			
			// return new points
			return currentPositions;
		}
		
		this.getMovementSum = function() {
		  if (movementSums.length < 10) return 999999;
		  //calc average
		  var msavg = 0;
		  for (var i = 0;i < movementSums.length;i++) {
		    msavg += movementSums[i];
		  }
		  msavg /= movementSums.length
		  return msavg;
		}
		
		var drawPath = function(canvasContext, path, dp) {
			canvasContext.beginPath();
			var i, x, y, a, b;
			for (var p = 0;p < path.length;p++) {
				i = path[p]*2;
				x = meanShape[i/2][0];
				y = meanShape[i/2][1];
				for (var j = 0;j < numParameters;j++) {
					x += pModel.shapeModel.eigenVectors[i][j]*dp[j+4];
					y += pModel.shapeModel.eigenVectors[i+1][j]*dp[j+4];
				}
				a = dp[0]*x - dp[1]*y + dp[2];
				b = dp[0]*y + dp[1]*x + dp[3];
				x += a;
				y += b;
				
				if (i == 0) {
					canvasContext.moveTo(x,y);
				} else {
					canvasContext.lineTo(x,y);
				}
			}
			canvasContext.moveTo(0,0);
			canvasContext.closePath();
			canvasContext.stroke();
		}
		
		function drawPoint(canvasContext, point, dp) {
			var i, x, y, a, b;
			i = point*2;
			x = meanShape[i/2][0];
			y = meanShape[i/2][1];
			for (var j = 0;j < numParameters;j++) {
				x += pModel.shapeModel.eigenVectors[i][j]*dp[j+4];
				y += pModel.shapeModel.eigenVectors[i+1][j]*dp[j+4];
			}
			a = dp[0]*x - dp[1]*y + dp[2];
			b = dp[0]*y + dp[1]*x + dp[3];
			x += a;
			y += b;
			canvasContext.beginPath();
			canvasContext.arc(x, y, 1, 0, Math.PI*2, true);
			canvasContext.closePath();
			canvasContext.fill();
		}
		
		this.draw = function(canvas, pv) {
			// if no previous points, just draw in the middle of canvas
			
			var params;
			if (pv === undefined) {
				params = currentParameters.slice(0);
			} else {
				params = pv.slice(0);
			}
			
			var cc = canvas.getContext('2d');
			cc.fillStyle = "rgb(200,200,200)";
			cc.strokeStyle = "rgb(130,255,50)";
			//cc.lineWidth = 1;
			cc.save();
			
			var paths = pModel.path.normal;
			for (var i = 0;i < paths.length;i++) {
				if (typeof(paths[i]) == 'number') {
					drawPoint(cc, paths[i], params);
				} else {
					drawPath(cc, paths[i], params);
				}
			}
			
			cc.restore()
		}
		
		function procrustes(template, shape) {
			// assume template and shape is a vector of x,y-coordinates
			//i.e. template = [[x1,y1], [x2,y2], [x3,y3]];
			var templateClone = [];
			var shapeClone = [];
			for (var i = 0;i < template.length;i++) {
				templateClone[i] = [template[i][0], template[i][1]];
			}
			for (var i = 0;i < shape.length;i++) {
				shapeClone[i] = [shape[i][0], shape[i][1]];
			}
			shape = shapeClone;
			template = templateClone;
			
			// calculate translation
			var templateMean = [0.0, 0.0];
			for (var i = 0;i < template.length;i++) {
				templateMean[0] += template[i][0];
				templateMean[1] += template[i][1];
			}
			templateMean[0] /= template.length;
			templateMean[1] /= template.length;
			
			var shapeMean = [0.0, 0.0];
			for (var i = 0;i < shape.length;i++) {
				shapeMean[0] += shape[i][0];
				shapeMean[1] += shape[i][1];
			}
			shapeMean[0] /= shape.length;
			shapeMean[1] /= shape.length;
			
			var translationX = templateMean[0] - shapeMean[0];
			var translationY = templateMean[1] - shapeMean[1];
			
			// centralize
			for (var i = 0;i < shape.length;i++) {
				shape[i][0] -= shapeMean[0];
				shape[i][1] -= shapeMean[1];
			}
			for (var i = 0;i < template.length;i++) {
				template[i][0] -= templateMean[0];
				template[i][1] -= templateMean[1];
			}
			
			// scaling
			
			var scaleS = 0.0;
			for (var i = 0;i < shape.length;i++) {
				scaleS += ((shape[i][0])*(shape[i][0]));
				scaleS += ((shape[i][1])*(shape[i][1]));
			}
			scaleS = Math.sqrt(scaleS/shape.length);
			
			var scaleT = 0.0;
			for (var i = 0;i < template.length;i++) {
				scaleT += ((template[i][0])*(template[i][0]));
				scaleT += ((template[i][1])*(template[i][1]));
			}
			scaleT = Math.sqrt(scaleT/template.length);
			
			var scaling = scaleT/scaleS;
			
			for (var i = 0;i < shape.length;i++) {
				shape[i][0] *= scaling;
				shape[i][1] *= scaling;
			}
				
			// rotation
			
			var top = 0.0;
			var bottom = 0.0;
			for (var i = 0;i < shape.length;i++) {
				top += (shape[i][0]*template[i][1] - shape[i][1]*template[i][0]);
				bottom += (shape[i][0]*template[i][0] + shape[i][1]*template[i][1]);
			}
			var rotation = Math.atan(top/bottom);
			
			translationX += (shapeMean[0]-(scaling*Math.cos(-rotation)*shapeMean[0])-(scaling*shapeMean[1]*Math.sin(-rotation)));
			translationY += (shapeMean[1]+(scaling*Math.sin(-rotation)*shapeMean[0])-(scaling*shapeMean[1]*Math.cos(-rotation)));
			
			//returns rotation, scaling, transformx and transformx
			return [translationX, translationY, scaling, rotation];
		}
		
		var drawData = function(canvasContext, data, width, height, transposed, drawX, drawY) {
			var psci = canvasContext.createImageData(width, height);
			var pscidata = psci.data;
			for (var j = 0;j < width*height;j++) {
			if (!transposed) {
				var val = data[(j%width)+((j/width) >> 0)*width];
			} else {
				var val = data[(j%height)*height+((j/height) >> 0)];
			}
			val = val > 255 ? 255 : val;
			val = val < 0 ? 0 : val;
			pscidata[j*4] = val;
			pscidata[(j*4)+1] = val;
			pscidata[(j*4)+2] = val;
			pscidata[(j*4)+3] = 255;
			}
			canvasContext.putImageData(psci, drawX, drawY);
		}
		
		return true;
	}
}