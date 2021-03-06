"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var child_process_1 = require("child_process");
var crypto = require("crypto");
var ip = require("ip");
var Jimp = require("jimp");
var optional = require("optional");
var FFMPEG = /** @class */ (function () {
    function FFMPEG(uuidfunc, hap, cameraConfig, log, videoProcessor, stillImageFilename) {
        this.streamControllers = [];
        this.cameraControllers = [];
        this.pendingSessions = [];
        this.ongoingSessions = [];
        this.services = [];
        if (uuidfunc === undefined) {
            throw Error("UUIDGen undefined");
        }
        if (hap.Service === undefined) {
            throw Error("Service undefined");
        }
        if (log === undefined) {
            throw Error("Log undefined");
        }
        if (hap.StreamController === undefined) {
            throw Error("StreamController undefined");
        }
        if (cameraConfig.videoConfig.debug) {
            log("FFMPEG constructor");
        }
        this.sharp = optional("sharp");
        this.uuid = uuidfunc;
        this.service = hap.Service;
        this.log = log;
        this.streamController = hap.StreamController;
        var ffmpegOpt = cameraConfig.videoConfig;
        this.name = cameraConfig.name;
        this.vcodec = ffmpegOpt.vcodec;
        this.videoProcessor = videoProcessor || "ffmpeg";
        this.fps = ffmpegOpt.maxFPS || 10;
        this.maxBitrate = ffmpegOpt.maxBitrate || 300;
        this.debug = ffmpegOpt.debug || false;
        if (this.debug) {
            log("Debug loggin enabled...");
        }
        if (!ffmpegOpt.source) {
            throw new Error("Missing source for camera.");
        }
        this.ffmpegSource = ffmpegOpt.source;
        this.ffmpegImageSource = ffmpegOpt.stillImageSource;
        this.stillImageFilename = stillImageFilename;
        var numberOfStreams = ffmpegOpt.maxStreams || 2;
        var options = {
            audio: {
                codecs: [
                    {
                        samplerate: 24,
                        type: "OPUS",
                    },
                    {
                        samplerate: 16,
                        type: "AAC-eld",
                    },
                ],
                comfort_noise: false,
            },
            disable_audio_proxy: false,
            proxy: false,
            srtp: true,
            video: {
                codec: {
                    levels: [0, 1, 2],
                    profiles: [0, 1, 2],
                },
                resolutions: [
                    [640, 640, 30],
                    [640, 640, 15],
                    [640, 480, 30],
                    [640, 480, 15],
                    [640, 360, 30],
                    [640, 360, 15],
                    [480, 360, 30],
                    [480, 360, 15],
                    [480, 270, 30],
                    [480, 270, 15],
                    [320, 240, 30],
                    [320, 240, 15],
                    [320, 180, 30],
                    [320, 180, 15],
                ],
            },
        };
        this.createCameraControlService();
        if (this.cameraControllers.length < 1) {
            throw Error("Did not push camera controller...");
        }
        this._createStreamControllers(numberOfStreams, options);
    }
    FFMPEG.prototype.handleCloseConnection = function (connectionID) {
        if (this.debug) {
            this.log("closing connection for " + this.streamControllers.length + " stream(s)...");
        }
        this.streamControllers.forEach(function (controller) {
            controller.handleCloseConnection(connectionID);
        });
    };
    // Image request: {width: number, height: number}
    // Please override this and invoke callback(error, image buffer) when the snapshot is ready
    FFMPEG.prototype.handleSnapshotRequest = function (request, callback) {
        var _this = this;
        var dir = __dirname;
        if (dir.endsWith("/lib")) {
            dir = dir.replace("/lib", "");
        }
        var path = dir + "/" + this.stillImageFilename;
        if (this.debug) {
            this.log("Delivering snapshot at path: " + path);
        }
        if (this.sharp == null) {
            if (this.debug) {
                this.log("... using Jimp");
            }
            Jimp.read(path)
                .then(function (image) {
                image
                    .resize(request.width, Jimp.AUTO)
                    .crop(0, (image.bitmap.height - request.height) / 2, request.width, request.height)
                    .quality(90)
                    .getBuffer(Jimp.MIME_JPEG, function (error, buffer) {
                    if (error !== null) {
                        if (_this.debug) {
                            _this.log("Error getting buffer for snapshot: " + error);
                        }
                        callback(error, undefined);
                    }
                    else {
                        callback(undefined, buffer);
                    }
                });
            })
                .catch(function (error) {
                if (_this.debug) {
                    _this.log("Error reading snapshot at path: " + error);
                }
                callback(error, undefined);
            });
        }
        else {
            if (this.debug) {
                this.log("... using Sharp");
            }
            this.sharp(path)
                .resize(request.width, request.height)
                .toBuffer()
                .then(function (data) { return callback(undefined, data); })
                .catch(function (error) { return callback(error, undefined); });
        }
    };
    FFMPEG.prototype.prepareStream = function (request, callback) {
        if (this.debug) {
            this.log("prepareStream");
        }
        var sessionInfo = {};
        var sessionID = request.sessionID;
        var targetAddress = request.targetAddress;
        sessionInfo.address = targetAddress;
        var response = {};
        var videoInfo = request.video;
        if (videoInfo) {
            var targetPort = videoInfo.port;
            var srtpKey = videoInfo.srtp_key;
            var srtpSalt = videoInfo.srtp_salt;
            if (this.debug) {
                this.log("srtpKey.length=" + srtpKey.length + ", srtpSalt.length=" + srtpSalt.length);
            }
            // SSRC is a 32 bit integer that is unique per stream
            var ssrcSource = crypto.randomBytes(4);
            ssrcSource[0] = 0;
            var ssrc = ssrcSource.readInt32BE(0, true);
            this.fps = videoInfo.fps || this.fps;
            var videoResp = {
                fps: videoInfo.fps,
                height: videoInfo.height,
                max_bit_rate: videoInfo.max_bit_rate,
                port: targetPort,
                srtp_key: srtpKey,
                srtp_salt: srtpSalt,
                ssrc: ssrc,
                width: videoInfo.width,
            };
            response.video = videoResp;
            sessionInfo.video_port = targetPort;
            sessionInfo.video_srtp = Buffer.concat([srtpKey, srtpSalt]);
            sessionInfo.video_ssrc = ssrc;
        }
        var audioInfo = request.audio;
        if (audioInfo) {
            var targetPort = audioInfo.port;
            var srtpKey = audioInfo.srtp_key;
            var srtpSalt = audioInfo.srtp_salt;
            // SSRC is a 32 bit integer that is unique per stream
            var ssrcSource = crypto.randomBytes(4);
            ssrcSource[0] = 0;
            var ssrc = ssrcSource.readInt32BE(0, true);
            var audioResp = {
                port: targetPort,
                srtp_key: srtpKey,
                srtp_salt: srtpSalt,
                ssrc: ssrc,
            };
            response.audio = audioResp;
            sessionInfo.audio_port = targetPort;
            sessionInfo.audio_port = Buffer.concat([srtpKey, srtpSalt]);
            sessionInfo.audio_ssrc = ssrc;
        }
        var currentAddress = ip.address();
        var addressResp = {
            address: currentAddress,
            type: "v6",
        };
        if (ip.isV4Format(currentAddress)) {
            addressResp.type = "v4";
        }
        response.address = addressResp;
        this.pendingSessions[this.uuid.unparse(sessionID, 0)] = sessionInfo;
        callback(response);
    };
    FFMPEG.prototype.handleStreamRequest = function (request) {
        var _this = this;
        if (this.debug) {
            this.log("handleStreamRequest");
        }
        var platform = this;
        var sessionID = request.sessionID;
        var requestType = request.type;
        if (sessionID) {
            var sessionIdentifier = this.uuid.unparse(sessionID, 0);
            var sessionInfo = this.pendingSessions[sessionIdentifier];
            if (requestType === "start" && sessionInfo) {
                var width = 640;
                var height = 640;
                var fps = this.fps || 15;
                var vbitrate = this.maxBitrate;
                var vcodec = this.vcodec || "libx264";
                var packetsize = 1316; // 188 376
                var videoInfo = request.video;
                if (videoInfo) {
                    width = videoInfo.width;
                    height = videoInfo.height;
                    var expectedFPS = videoInfo.fps;
                    if (expectedFPS < fps) {
                        fps = expectedFPS;
                    }
                    if (videoInfo.max_bit_rate < vbitrate) {
                        vbitrate = videoInfo.max_bit_rate;
                    }
                }
                var targetAddress = sessionInfo.address;
                var targetVideoPort = sessionInfo.video_port;
                var videoKey = sessionInfo.video_srtp;
                var videoSsrc = sessionInfo.video_ssrc;
                var ffmpegCommand = "-threads 0 -an -re -r 1" +
                    " " + this.ffmpegSource +
                    " -vf fps=" + fps +
                    " -map 0:0" +
                    " -f mp4 -vcodec " + vcodec +
                    " -preset faster" +
                    " -pix_fmt yuv420p -an" +
                    " -r " + fps +
                    " -g " + (fps * 2) +
                    " -movflags frag_keyframe+empty_moov -tune stillimage" +
                    " -b:v " + vbitrate + "k" +
                    " -bufsize " + vbitrate + "k" +
                    " -maxrate " + vbitrate + "k" +
                    " -payload_type 99" +
                    " -ssrc " + videoSsrc +
                    " -f rtp" +
                    " -srtp_out_suite AES_CM_128_HMAC_SHA1_80" +
                    " -srtp_out_params " + videoKey.toString("base64") +
                    " srtp://" + targetAddress + ":" + targetVideoPort +
                    "?rtcpport=" + targetVideoPort +
                    "&localrtcpport=" + targetVideoPort +
                    "&pkt_size=" + packetsize;
                var ffmpeg = child_process_1.spawn(this.videoProcessor, ffmpegCommand.split(" "), { env: process.env });
                this.log("Start streaming video from " + this.name + " with " + width + "x" + height + "@" + vbitrate + "kBit");
                if (this.debug) {
                    this.log("ffmpeg " + ffmpegCommand);
                }
                ffmpeg.stdout.on("data", function (data) {
                    // Do not log to the console if debugging is turned off
                    if (platform.debug) {
                        platform.log(data.toString());
                    }
                });
                // Always setup hook on stderr.
                // Without this streaming stops within one to two minutes.
                ffmpeg.stderr.on("data", function (data) {
                    // Do not log to the console if debugging is turned off
                    if (platform.debug) {
                        platform.log(data.toString());
                    }
                });
                ffmpeg.on("error", function (error) {
                    platform.log("An error occurs while making stream request");
                    if (platform.debug) {
                        platform.log(error);
                    }
                });
                ffmpeg.on("close", function (code) {
                    if (code == null || code === 0 || code === 255) {
                        platform.log("Stopped streaming");
                    }
                    else {
                        platform.log("ERROR: FFmpeg exited with code " + code);
                        for (var _i = 0, _a = _this.streamControllers; _i < _a.length; _i++) {
                            var controller = _a[_i];
                            if (controller.sessionIdentifier === sessionID) {
                                controller.forceStop();
                            }
                        }
                    }
                });
                this.ongoingSessions[sessionIdentifier] = ffmpeg;
                delete this.pendingSessions[sessionIdentifier];
            }
            else if (requestType === "stop") {
                var ffmpegProcess = this.ongoingSessions[sessionIdentifier];
                if (ffmpegProcess) {
                    ffmpegProcess.kill("SIGTERM");
                }
                delete this.ongoingSessions[sessionIdentifier];
            }
        }
    };
    FFMPEG.prototype.createCameraControlService = function () {
        if (this.service.CameraControl === undefined) {
            throw Error("CameraControl undefined");
        }
        if (this.debug) {
            this.log("createCameraControlService");
        }
        var controlService = new this.service.CameraControl();
        this.services.push(controlService);
        this.cameraControllers.push(controlService);
        if (this.services.filter(function (s) { return s === controlService; }).length < 1) {
            throw Error("Failed to register Camera Control Service...");
        }
    };
    // Private
    FFMPEG.prototype._createStreamControllers = function (maxStreams, options) {
        if (this.debug) {
            this.log("_createStreamControllers");
        }
        for (var i = 0; i < maxStreams; i++) {
            if (this.debug) {
                this.log("adding StreamController #" + (i + 1) + "/" + maxStreams);
            }
            var streamController = new this.streamController(i, options, this);
            this.services.push(streamController.service);
            this.streamControllers.push(streamController);
        }
        if (this.debug) {
            this.log(this.streamControllers.length + "/" + maxStreams + " stream controllers registered");
        }
    };
    return FFMPEG;
}());
exports.FFMPEG = FFMPEG;
exports.default = FFMPEG;
