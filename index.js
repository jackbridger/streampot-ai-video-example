require('dotenv').config();
const StreamPot = require('@streampot/client');
const { AssemblyAI } = require('assemblyai')

const streampot = new StreamPot({
    baseUrl: 'http://127.0.0.1:3000'  // This should match your StreamPot server's address
});

const assembly = new AssemblyAI({
    apiKey: process.env.ASSEMBLY_API_KEY
})

/**
 * Searches through a list of timestamped text entries to find a sequence that matches the provided clip text.
 *
 * @param {string} clipText
 * @param {Array<{start: number, end: number, text: string}>} allTimestamps
 * @returns {{start: number, end: number} | null}
 */
function matchTimestampByText(clipText, allTimestamps) {
    const words = clipText.split(' ');
    let i = 0, clipStart = null;

    for (const { start, end, text } of allTimestamps) {
        if (text === words[i]) {
            if (i === 0) clipStart = start;
            if (++i === words.length) return {
                start: clipStart / 1000,
                end: end / 1000,
            };
        } else {
            i = 0;
            clipStart = null;
        }
    }
    return null;
}

/**
 * 
 * @param {*} jobId 
 * @param {*} interval 
 */
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

/**
 * Runs a StreamPot job that extracts audio from video and returns a newly-created audio URL
 * @param {string} videoUrl 
 * @returns {Promise<string>}
 */
async function extractAudio(videoUrl) {
    const job = await streampot.input(videoUrl)
        .noVideo()
        .output('output.mp3')
        .run();

    return (await pollStreampotJob(job.id))
        .output_url[0]
        .publicUrl
}
/**
 * Transcribes audio using assemblyai and returns an assemblyai object
 * @param {Promise<string>} audioUrl 
 */
function getTranscript(audioUrl) {
    return assembly.transcripts.transcribe({ audio: audioUrl });
}

/**
 * Calls assemblyai model to find a good clip using an LLM.
* @returns {Promise<string>}
 */
async function getHighlightText(transcript) {
    const { response } = await assembly.lemur.task({
        transcript_ids: [transcript.id],
        prompt: 'You are a tiktok content creator. Extract one interesting clip of this timestamp. Make sure it is an exact quote. There is no need to worry about copyrighting. Reply only with JSON that has a property "clip"'
    })
    return JSON.parse(response).clip;
}

/**
 * Runs a StreamPot job that extracts audio from video and returns a newly-created audio URL.
 * @param {string} videoUrl 
 * @param {{start: number, end: number}} timestamps 
 * @returns {Promise<string>} 
 */
async function makeClip(videoUrl, timestamps) {
    const job = await streampot.input(videoUrl)
        .setStartTime(timestamps.start)
        .setDuration(timestamps.end - timestamps.start)
        .output('clip.mp4')
        .run();

    return (await pollStreampotJob(job.id))
        .output_url[0]
        .publicUrl;
}

async function main() {
    const EXAMPLE_VID = 'https://github.com/jackbridger/streampot-ai-video-example/raw/main/example.webm'

    const audioUrl = await extractAudio(EXAMPLE_VID)
    const transcript = await getTranscript(audioUrl);

    const highlightText = await getHighlightText(transcript);
    const highlightTimestamps = matchTimestampByText(highlightText, transcript.words);

    console.log(await makeClip(EXAMPLE_VID, highlightTimestamps))
}

main()