require('dotenv').config(); // if you are on node < v21
const StreamPot = require('@streampot/client');

const streampot = new StreamPot({
    baseUrl: 'http://127.0.0.1:3000'  // This should match your StreamPot server's address
});


async function extractAudio(videoUrl) {
    const job = await streampot.input(videoUrl)
        .noVideo()
        .output('output.mp3')
        .run();

    return (await pollStreampotJob(job.id))
        .output_url[0]
        .public_url
}

async function pollStreampotJob(jobId, interval = 5000) {
    while (true) {
        const job = await streampot.checkStatus(jobId);
        if (job.status === 'completed') {
            return job;
        } else if (job.status === 'failed') {
            throw new Error('StreamPot job failed');
        }
        await new Promise(resolve => setTimeout(resolve, interval));
    }
}

async function main() {
    const EXAMPLE_VID = 'https://github.com/jackbridger/streampot-ai-video-example/raw/main/example.webm'
    const audioUrl = await extractAudio(EXAMPLE_VID)
    console.log(audioUrl)
}
main()