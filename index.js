const core = require('@actions/core');
const exec = require('@actions/exec');
const common = require('@zaproxy/actions-common-scans');
const _ = require('lodash');

// Default file names
let jsonReportName = 'report_json.json';
let mdReportName = 'report_md.md';
let htmlReportName = 'report_html.html';

async function run() {

    try {
        let workspace = process.env.GITHUB_WORKSPACE;
        let currentRunnerID = process.env.GITHUB_RUN_ID;
        let repoName = process.env.GITHUB_REPOSITORY;
        let token = core.getInput('token');
        let docker_name = core.getInput('docker_name');
        let target = core.getInput('target');
        let rulesFileLocation = core.getInput('rules_file_name');
        let cmdOptions = core.getInput('cmd_options');
        let issueTitle = core.getInput('issue_title');
        let failAction = core.getInput('fail_action');
        let allowIssueWriting = core.getInput('allow_issue_writing');
        let artifactName = core.getInput('artifact_name');
        let createIssue = true;

        if (!(String(failAction).toLowerCase() === 'true' || String(failAction).toLowerCase() === 'false')) {
            console.log('[WARNING]: \'fail_action\' action input should be either \'true\' or \'false\'');
        }

        if (String(allowIssueWriting).toLowerCase() === 'false') {
            createIssue = false;
        }

        if (!artifactName) {
            console.log('[WARNING]: \'artifact_name\' action input should not be empty. Setting it back to the default name.');
            artifactName = 'zap_scan';
        }

        console.log('starting the program');
        console.log('github run id :' + currentRunnerID);

        let plugins = [];
        if (rulesFileLocation) {
            plugins = await common.helper.processLineByLine(`${workspace}/${rulesFileLocation}`);
        }

        // Allow writing files from the Docker container.
        await exec.exec(`chmod a+w ${workspace}`);

        await exec.exec(`docker pull ${docker_name} -q`);

        // FORK NOTE: upstream uses `docker run -v ${workspace}:/zap/wrk/:rw`,
        // a host-path bind mount. That only works when the Docker CLI and
        // the Docker daemon share a filesystem. On self-hosted runners whose
        // daemon lives in a sibling DinD (Docker-in-Docker) container, the
        // runner's `${workspace}` path is invisible to that daemon, so the
        // mount silently binds an empty directory (ZAP then can't find the
        // rules file or write any report). `docker cp` instead streams files
        // over the Docker API, which works identically whether the daemon is
        // local or remote — so we create the container without a volume,
        // copy the workspace in, run it, then copy the reports back out.
        let containerName = `zap_scan_${currentRunnerID}`;
        let cmdArgs = (`zap-baseline.py -t ${target} -J ${jsonReportName} -w ${mdReportName}  -r ${htmlReportName} ${cmdOptions}`);

        if (plugins.length !== 0) {
            cmdArgs = cmdArgs + ` -c ${rulesFileLocation}`
        }

        await exec.exec(`docker create --name ${containerName} --network="host" -e ZAP_AUTH_HEADER -e ZAP_AUTH_HEADER_VALUE -e ZAP_AUTH_HEADER_SITE -t ${docker_name} ${cmdArgs}`);
        // Copies the whole workspace (not just the rules file) into
        // /zap/wrk, mirroring what the bind mount used to expose. Docker
        // only auto-creates ONE missing intermediate directory when copying
        // into a container, and /zap/wrk doesn't exist in the image yet, so
        // this must be a single directory-to-single-new-path copy.
        await exec.exec(`docker cp ${workspace}/. ${containerName}:/zap/wrk`);

        let command = `docker start -a ${containerName}`;

        try {
            await exec.exec(command);
        } catch (err) {
            if (err.toString().includes('exit code 3')) {
                await exec.exec(`docker rm -f ${containerName}`);
                core.setFailed('failed to scan the target: ' + err.toString());
                return
            }

            if ((err.toString().includes('exit code 2') || err.toString().includes('exit code 1'))
                    && String(failAction).toLowerCase() === 'true') {
                console.log(`[info] By default ZAP Docker container will fail if it identifies any alerts during the scan!`);
                core.setFailed('Scan action failed as ZAP has identified alerts, starting to analyze the results. ' + err.toString());
            }else {
                console.log('Scanning process completed, starting to analyze the results!')
            }
        }

        await exec.exec(`docker cp ${containerName}:/zap/wrk/${jsonReportName} ${workspace}/${jsonReportName}`);
        await exec.exec(`docker cp ${containerName}:/zap/wrk/${mdReportName} ${workspace}/${mdReportName}`);
        await exec.exec(`docker cp ${containerName}:/zap/wrk/${htmlReportName} ${workspace}/${htmlReportName}`);
        await exec.exec(`docker rm -f ${containerName}`);

        await common.main.processReport(token, workspace, plugins, currentRunnerID, issueTitle, repoName, createIssue, artifactName);
    } catch (error) {
        core.setFailed(error.message);
    }
}

run();
