function IgnisResizer(ignis)
{
    this.ignis = ignis;
    ignis.resizer = this;

    this.thumb_batch_processes = [];
    this.tex_batch_processes = [];
    this.export_batch_processes = [];
    this.thumb_batch_callback = null;
    this.tex_batch_callback = null;
    this.export_batch_callback = null;
}

IgnisResizer.prototype.init = function ()
{
}

IgnisResizer.prototype.execFile = function (cmd, params, callback)
{
    window.electronApi.execFile(cmd, params).then(function (result) {
        if (callback) {
            callback(result.error, result.stdout, result.stderr);
        }
    });
}

IgnisResizer.prototype.thumb = function (from, to, max_size, callback)
{
    this.thumbBatch([{from: from, to: to}], max_size, callback);
}

IgnisResizer.prototype.export = function (from, to, max_size, callback)
{
    this.exportBatch([{from: from, to: to}], max_size, callback);
}

IgnisResizer.prototype.tex = function (from, to, leds, quality, callback)
{
    this.texBatch([{from: from, to: to}], leds, quality, callback);
}

IgnisResizer.prototype.thumbBatch = function (batch, max_size, callback)
{
    if (window.electronApi.platform == "darwin" || config.forcePlatform == "darwin") {
        return this.thumbBatchMac(batch, max_size, callback);
    }

    var cmd = "resizer.exe";
    var params = ['thumb', max_size];

    var cfg_file = this.prepareBatchConfig(batch);
    params.push(cfg_file);

    this.execFile(cmd, params, callback);
}

IgnisResizer.prototype.prepareBatchConfig = function (batch)
{
    var tmp = [];
    for (var o of batch) {
        tmp.push(o.from + '|' + o.to);
    }

    var resizer_dir = ignis_dir('resizer');
    var cfg_hash = window.electronApi.md5(Math.round((new Date()).getTime() / 1000) + '_' + Math.random() * 10000);
    var cfg_file = resizer_dir + path.sep + cfg_hash + '.batch';
    fs.writeFileSync(cfg_file, tmp.join('\n'));

    return cfg_file;
}

IgnisResizer.prototype.exportBatch = function (batch, max_size, callback)
{
    if (window.electronApi.platform == "darwin" || config.forcePlatform == "darwin") {
        return this.exportBatchMac(batch, max_size, callback);
    }

    var cmd = "resizer.exe";
    var params = ['export', max_size];

    var cfg_file = this.prepareBatchConfig(batch);
    params.push(cfg_file);

    this.execFile(cmd, params, callback);
}

IgnisResizer.prototype.texBatch = function (batch, leds, quality, callback)
{
    if (window.electronApi.platform == "darwin" || config.forcePlatform == "darwin") {
        return this.texBatchMac(batch, leds, quality, callback);
    }

    if (!quality) quality = config.rendering.texture_quality;

    var cmd = "resizer.exe";
    var params = ['tex', leds, quality];

    var cfg_file = this.prepareBatchConfig(batch);
    params.push(cfg_file);

    this.execFile(cmd, params, callback);
}

IgnisResizer.prototype.fileUrl = function (filePath)
{
    var url = filePath.split(path.sep).join('/');
    if (/^[a-zA-Z]:/.test(url)) url = '/' + url;
    return 'file://' + encodeURI(url).replace(/#/g, '%23').replace(/\?/g, '%3F');
}

IgnisResizer.prototype.writeCanvasFile = function (canvas, to, callback)
{
    try {
        var ext = path.extname(to).toLowerCase();
        var mime = ext == '.png' ? 'image/png' : 'image/jpeg';
        var quality = mime == 'image/jpeg' ? 0.92 : undefined;
        var dataUrl = quality ? canvas.toDataURL(mime, quality) : canvas.toDataURL(mime);
        var data = dataUrl.replace(/^data:image\/(png|jpeg);base64,/, '');
        fs.writeFileSync(to, Buffer.from(data, 'base64'));
        if (callback) callback(null, null);
    } catch (err) {
        console.error('Canvas resize write failed:', to, err);
        if (callback) callback(err);
    }
}

IgnisResizer.prototype.loadCanvasImage = function (from, callback)
{
    var done = false;
    var img = new Image();
    var finish = function (err) {
        if (done) return;
        done = true;
        callback(err, img);
    };

    var timer = setTimeout(function () {
        finish(new Error('Image load timed out: ' + from));
    }, 30000);

    img.onload = function () {
        clearTimeout(timer);
        finish(null);
    };
    img.onerror = function () {
        clearTimeout(timer);
        finish(new Error('Image load failed: ' + from));
    };
    img.src = this.fileUrl(from);
}

IgnisResizer.prototype.drawCanvasImage = function (img, width, height, options)
{
    options = options || {};
    width = Math.max(1, Math.round(width));
    height = Math.max(1, Math.round(height));

    var canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = options.smoothing !== false;
    if (ctx.imageSmoothingQuality) ctx.imageSmoothingQuality = options.quality || 'high';

    ctx.save();
    if (options.rotate180) {
        ctx.translate(width, height);
        ctx.rotate(Math.PI);
    } else if (options.flipH || options.flipV) {
        ctx.translate(options.flipH ? width : 0, options.flipV ? height : 0);
        ctx.scale(options.flipH ? -1 : 1, options.flipV ? -1 : 1);
    }
    ctx.drawImage(img, 0, 0, width, height);
    ctx.restore();

    return canvas;
}

IgnisResizer.prototype.processCanvasBatch = function (batch, worker, callback)
{
    var items = (batch || []).slice(0);
    var firstError = null;

    var next = $.proxy(function () {
        if (items.length == 0) {
            if (callback) callback(firstError, null);
            return;
        }

        var item = items.shift();
        worker.call(this, item, $.proxy(function (err) {
            if (err && !firstError) firstError = err;
            setTimeout(next, 0);
        }, this));
    }, this);

    next();
}

IgnisResizer.prototype.thumbBatchMac = function (batch, max_size, callback)
{
    max_size = parseInt(max_size || 300);
    if (isNaN(max_size) || max_size < 64) max_size = 300;

    this.processCanvasBatch(batch, function (item, done) {
        this.loadCanvasImage(item.from, $.proxy(function (err, img) {
            if (err) return done(err);
            var ratio = Math.min(max_size / img.width, max_size / img.height, 1);
            var width = Math.max(1, Math.round(img.width * ratio));
            var height = Math.max(1, Math.round(img.height * ratio));
            var canvas = this.drawCanvasImage(img, width, height, { smoothing: true, quality: 'high' });
            this.writeCanvasFile(canvas, item.to, done);
        }, this));
    }, callback);
}

IgnisResizer.prototype.thumbBatchExit = function (process)
{
    var that = this;

    that.thumb_batch_processes.splice(that.thumb_batch_processes.indexOf(process), 1);
    if (that.thumb_batch_processes.length == 0) {
        if (that.thumb_batch_callback) {
            that.thumb_batch_callback();
            that.thumb_batch_callback = null;
        }
    }
}

IgnisResizer.prototype.exportBatchMac = function (batch, max_size, callback)
{
    max_size = parseInt(max_size || config.project.default_leds || 80);
    if (isNaN(max_size) || max_size < 1) max_size = config.project.default_leds || 80;

    this.processCanvasBatch(batch, function (item, done) {
        this.loadCanvasImage(item.from, $.proxy(function (err, img) {
            if (err) return done(err);
            var height = max_size;
            var width = Math.max(1, Math.round(img.width * (height / img.height)));
            var canvas = this.drawCanvasImage(img, width, height, { smoothing: true, quality: 'high' });
            this.writeCanvasFile(canvas, item.to, done);
        }, this));
    }, callback);
}

IgnisResizer.prototype.thumbExportExit = function (process)
{
    var that = this;

    that.export_batch_processes.splice(that.export_batch_processes.indexOf(process), 1);
    if (that.export_batch_processes.length == 0) {
        if (that.export_batch_callback) {            
            that.export_batch_callback();
            that.export_batch_callback = null;
        }
    }
}

IgnisResizer.prototype.texBatchMac = function (batch, leds, quality, callback)
{
    var size = parseInt(quality || config.rendering.texture_quality || 512);
    if (isNaN(size) || size < 64) size = 512;

    this.processCanvasBatch(batch, function (item, done) {
        this.loadCanvasImage(item.from, $.proxy(function (err, img) {
            if (err) return done(err);
            var canvas = this.drawCanvasImage(img, size, size, { smoothing: false });
            this.writeCanvasFile(canvas, item.to, done);
        }, this));
    }, callback);
}

IgnisResizer.prototype.thumbTexExit = function (process)
{
    var that = this;

    that.tex_batch_processes.splice(that.tex_batch_processes.indexOf(process), 1);
    if (that.tex_batch_processes.length == 0) {
        if (that.tex_batch_callback) {
            that.tex_batch_callback();
            that.tex_batch_callback = null;
        }
    }
}

IgnisResizer.prototype.resize = function (mode, from, to, width, height, callback)
{
    if (!mode) mode = 'single';

    if (window.electronApi.platform == "darwin" || config.forcePlatform == "darwin") {
        return this.resizeMac( mode, from, to, width, height, callback );
    }

    var cmd = "resizer.exe";
    var params = [mode, from, to, width, height];

    this.execFile(cmd, params, callback);
}

IgnisResizer.prototype.resizeMac = function (mode, from, to, width, height, callback)
{
    width = parseInt(width);
    height = parseInt(height);
    if (isNaN(width) || width < 1) width = 1;
    if (isNaN(height) || height < 1) height = 1;

    this.loadCanvasImage(from, $.proxy(function (err, img) {
        if (err) {
            if (callback) callback(err);
            return;
        }

        var canvas = this.drawCanvasImage(img, width, height, {
            smoothing: mode != 'point',
            rotate180: mode == 'rotate',
            flipH: mode == 'flip'
        });
        this.writeCanvasFile(canvas, to, callback);
    }, this));
}

IgnisResizer.prototype.stickMirrorGap = function (hash, leds, gap, rotate, reverse, callback)
{
    if (typeof reverse == 'function') {
        callback = reverse;
        reverse = false;
    }

    reverse = !!reverse;

    var mr = (rotate ? '_r' : '_m') + (reverse ? 'v' : '');
    var fn_tex = ignis_dir('tex') + path.sep + hash + mr + gap + '_' + leds + '.jpg';
    var fn_mir = ignis_dir('mirror') + path.sep + hash + mr + gap + '_' + leds + '.png';
    

    if (gap % 2 != 0) gap += 1;
    var height = (leds - gap) / 2;

    var i = this.ignis.library.getImageByHash(hash);
    var width = Math.round(height * i.resolution.r);
    
    var from = i.path;
    var to = ignis_dir('tmp') + path.sep + hash + '_h_' + width + '_' + height;
    
    this.resize('single', from, to + '.png', width, height, $.proxy(function () {
        this.resize((rotate ? 'rotate' : 'flip'), from, to + (rotate ? '_rotate.png' : '_flip.png'), width, height, $.proxy(function () {
            var top = to + '.png';
            var bot = to + (rotate ? '_rotate.png' : '_flip.png');

            var img_top = new Image();
            img_top.onload = $.proxy(function () {
                var img_bot = new Image();
                img_bot.onload = $.proxy(function () {
                    var canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = 2 * height + gap;
                    var ctx = canvas.getContext('2d');
                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                    if (reverse) {
                        ctx.drawImage(img_bot, 0, 0);
                        ctx.drawImage(img_top, 0, height + gap);
                    } else {
                        ctx.drawImage(img_top, 0, 0);
                        ctx.drawImage(img_bot, 0, height + gap);
                    }
            
                    var data = canvas.toDataURL("image/png").split(',', 2)[1];
                    var buff = Buffer.from(data, 'base64');
                    fs.writeFileSync(fn_mir, buff);

                    this.resize('point', fn_mir, fn_tex, 512, 512, $.proxy(function () {
                        if (callback) callback();
                    }, this));
                }, this);
                img_bot.src = bot;
            }, this);
            img_top.src = top;
        }, this));
    }, this));
}
