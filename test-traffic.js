// Test script for traffic reporting
const axios = require('axios');

const API_URL = 'http://localhost:2096';

async function testTrafficReporting() {
    console.log('Testing traffic reporting API...');
    
    // Test data
    const testData = {
        user_id: 'test_user_123',
        server_id: 'test_server_456',
        upload_bytes: 1024 * 1024 * 500, // 500 MB
        download_bytes: 1024 * 1024 * 1000 // 1 GB
    };
    
    try {
        // Report traffic
        console.log('Reporting traffic data:', testData);
        const reportResponse = await axios.post(`${API_URL}/api/traffic/report`, testData);
        console.log('Traffic report response:', reportResponse.data);
        
        // Get user traffic
        console.log('\nGetting user traffic...');
        const trafficResponse = await axios.get(`${API_URL}/api/traffic/user/${testData.user_id}`);
        console.log('User traffic data:', trafficResponse.data);
        
        // Get all traffic
        console.log('\nGetting all traffic...');
        const allTrafficResponse = await axios.get(`${API_URL}/api/traffic/all`);
        console.log('All traffic data:', allTrafficResponse.data);
        
    } catch (error) {
        console.error('Error testing traffic API:', error.message);
    }
}

// Run test if this file is executed directly
if (require.main === module) {
    testTrafficReporting();
}

module.exports = { testTrafficReporting };