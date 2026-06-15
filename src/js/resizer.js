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
        if (result && result.error) {
            console.error('Resizer command failed:', cmd, params, result.error, result.stderr || '');
        }
        if (callback) {
            callback(result.error, result.stdout, result.stderr);
        }
    });
}

IgnisResizer.prototype.isMac = function ()
{
    return window.electronApi.platform == "darwin" || config.forcePlatform == "darwin";
}

IgnisResizer.prototype.getJimp = function ()
{
    if (!this.jimp) this.jimp = require('jimp');
    return this.jimp;
}

IgnisResizer.prototype.writeJimp = function (img, to, callback)
{
    img.write(to, function (err) {
        if (callback) callback(err || null, null, null);
    });
}

IgnisResizer.prototype.flattenForJpeg = function (img)
{
    var Jimp = this.getJimp();
    var bg = new Jimp(img.bitmap.width, img.bitmap.height, 0x000000ff);
    bg.composite(img, 0, 0);
    return bg;
}

IgnisResizer.prototype.runMacBatch = function (batch, worker, callback)
{
    if (!batch || batch.length == 0) {
        if (callback) callback(null, null);
        return;
    }

    var pending = batch.length;
    var firstError = null;

    var done = function (err) {
        if (err && !firstError) firstError = err;
        pending--;
        if (pending == 0 && callback) callback(firstError, null);
    };

    for (let i in batch) {
        worker.call(this, batch[i], done);
    }
}

IgnisResizer.prototype.readMacImage = function (from, callback)
{
    var Jimp = this.getJimp();
    Jimp.read(from)
        .then(function (img) {
            callback(null, img);
        })
        .catch(function (err) {
            console.error('Image read failed:', from, err);
            callback(err);
        });
}
IgnisResizer.prototype.windowsResizerPath = function ()
{
    var candidates = [];
    var vendorPath = ['vendor', 'win', 'resizer.exe'].join(path.sep);

    if (window.electronApi.resourcesPath) {
        candidates.push(window.electronApi.resourcesPath + path.sep + vendorPath);
    }

    if (window.electronApi.getAppPath) {
        var appPath = window.electronApi.getAppPath();
        candidates.push(appPath + path.sep + vendorPath);
        candidates.push(appPath + path.sep + '..' + path.sep + '..' + path.sep + vendorPath);
    }

    candidates.push('resizer.exe');

    for (var i in candidates) {
        var candidate = candidates[i];
        try {
            if (candidate == 'resizer.exe' || fs.existsSync(candidate)) {
                return candidate;
            }
        } catch (e) {
        }
    }

    return 'resizer.exe';
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
    if (this.isMac()) {
        return this.thumbBatchMac(batch, max_size, callback);
    }

    var cmd = this.windowsResizerPath();
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
    if (this.isMac()) {
        return this.exportBatchMac(batch, max_size, callback);
    }

    var cmd = this.windowsResizerPath();
    var params = ['export', max_size];

    var cfg_file = this.prepareBatchConfig(batch);
    params.push(cfg_file);

    this.execFile(cmd, params, callback);
}

IgnisResizer.prototype.texBatch = function (batch, leds, quality, callback)
{
    if (this.isMac()) {
        return this.texBatchMac(batch, leds, quality, callback);
    }

    if (!quality) quality = config.rendering.texture_quality;

    var cmd = this.windowsResizerPath();
    var params = ['tex', leds, quality];

    var cfg_file = this.prepareBatchConfig(batch);
    params.push(cfg_file);

    this.execFile(cmd, params, callback);
}

IgnisResizer.prototype.thumbBatchMac = function (batch, max_size, callback)
{
    var size = parseInt(max_size || config.rendering.thumbnail_quality || 300, 10);
    this.runMacBatch(batch, function (item, done) {
        this.readMacImage(item.from, $.proxy(function (err, img) {
            if (err) return done(err);
            img.scaleToFit(size, size);
            if (/\.jpe?g$/i.test(item.to)) img = this.flattenForJpeg(img).quality(90);
            this.writeJimp(img, item.to, done);
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
    var height = parseInt(max_size, 10);
    this.runMacBatch(batch, function (item, done) {
        this.readMacImage(item.from, $.proxy(function (err, img) {
            if (err) return done(err);
            var targetHeight = Math.max(1, height || img.bitmap.height);
            var width = Math.max(1, Math.round(img.bitmap.width * (targetHeight / img.bitmap.height)));
            img.resize(width, targetHeight);
            if (/\.jpe?g$/i.test(item.to)) img = this.flattenForJpeg(img).quality(90);
            this.writeJimp(img, item.to, done);
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
    var texHeight = parseInt(leds, 10);
    var texSize = parseInt(quality || config.rendering.texture_quality || 512, 10);
    var Jimp = this.getJimp();

    this.runMacBatch(batch, function (item, done) {
        this.readMacImage(item.from, $.proxy(function (err, img) {
            if (err) return done(err);
            var targetHeight = Math.max(1, texHeight || img.bitmap.height);
            var width = Math.max(1, Math.round(img.bitmap.width * (targetHeight / img.bitmap.height)));
            img.resize(width, targetHeight, Jimp.RESIZE_NEAREST_NEIGHBOR);
            img.resize(texSize, texSize, Jimp.RESIZE_NEAREST_NEIGHBOR);
            if (/\.jpe?g$/i.test(item.to)) img = this.flattenForJpeg(img).quality(95);
            this.writeJimp(img, item.to, done);
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

    if (this.isMac()) {
        return this.resizeMac( mode, from, to, width, height, callback );
    }

    var cmd = this.windowsResizerPath();
    var params = [mode, from, to, width, height];

    this.execFile(cmd, params, callback);
}

IgnisResizer.prototype.resizeMac = function (mode, from, to, width, height, callback)
{
    var Jimp = this.getJimp();
    var w = parseInt(width, 10);
    var h = parseInt(height, 10);

    this.readMacImage(from, $.proxy(function (err, img) {
        if (err) {
            if (callback) callback(err);
            return;
        }

        var targetWidth = Math.max(1, w || img.bitmap.width);
        var targetHeight = Math.max(1, h || img.bitmap.height);
        var resizeMode = (mode == 'point') ? Jimp.RESIZE_NEAREST_NEIGHBOR : Jimp.RESIZE_BILINEAR;
        img.resize(targetWidth, targetHeight, resizeMode);

        if (mode == 'rotate') {
            img.rotate(180, false);
        } else if (mode == 'flip') {
            img.flip(false, true);
        }

        if (/\.jpe?g$/i.test(to)) img = this.flattenForJpeg(img).quality(95);
        this.writeJimp(img, to, callback);
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
