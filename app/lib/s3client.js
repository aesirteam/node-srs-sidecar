'use strict';

const Minio = require('minio').Client,
      CronJob = require('cron').CronJob;

const s3Client = new Minio({
    endPoint: process.env.minio_endpoint || 'pan.bigdatagz.com',
    port: Number(process.env.minio_port || 80),
    useSSL: (process.env.minio_use_ssl === 'true'),
    accessKey: process.env.minio_accessKey || '',
    secretKey: process.env.minio_secretKey || ''
});

const bucketName = process.env.minio_bucketName || '',
      bucketPrefix = process.env.minio_bucketPrefix || '';

const removeObjects = (interval) => {
	var objectsList = []
	
	s3Client.listObjects(bucketName, bucketPrefix, true)
	 .on('data', (obj) => {
	 	let timeInterval =  Math.ceil((Date.now() - obj.lastModified) / 1000);
	 	
	 	if (timeInterval >= interval) {
	 		objectsList.push(obj.name)
	 	}
	 })
	 .on('end', () => {
	 	s3Client.removeObjects(bucketName, objectsList, (err) => {
	 		if (err) { return console.log(err); }
	 	})
	 })
	 .on('error', (err) => {
	 	console.log(err)
	 })
}

exports.init = () => {
	var interval = process.env.S3_REMOVE_INTERVAL_SECONDS || 0
	if (interval > 0) {
		new CronJob('0/10 * * * * *', () => { removeObjects(interval); }, null, true, 'Asia/Shanghai');
	}
}

exports.fPutObject = (objectName, filePath, callback) => {
	s3Client.fPutObject(bucketName, bucketPrefix.concat(objectName), filePath, {Content-Type: 'application/octet-stream'}, callback)
}

exports.getObject = (objectName, callback) => {
	s3Client.getObject(bucketName, bucketPrefix.concat(objectName), callback)
}